import { describe, it, expect, jest } from "@jest/globals";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readSbomFile, uploadSbom, SbomFileError } from "../upload-sbom";

const VALID_CYCLONEDX = JSON.stringify({
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  components: [{ type: "library", name: "example", version: "1.0.0" }],
});

function writeTempFile(content: string, filename = "sbom.json"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sbom-test-"));
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, content);
  return filePath;
}

describe("readSbomFile", () => {
  it("throws when the file does not exist", () => {
    expect(() => readSbomFile("/nonexistent/path/sbom.json")).toThrow(SbomFileError);
    expect(() => readSbomFile("/nonexistent/path/sbom.json")).toThrow(/not found/i);
  });

  it("throws when the file is empty", () => {
    const filePath = writeTempFile("");
    expect(() => readSbomFile(filePath)).toThrow(/empty/i);
  });

  it("throws when the file is not valid JSON (e.g. a partial write from a failed generation)", () => {
    const filePath = writeTempFile("{not json");
    expect(() => readSbomFile(filePath)).toThrow(/not valid JSON/i);
  });

  it("throws when the JSON is not a CycloneDX document", () => {
    const filePath = writeTempFile(JSON.stringify({ spdxVersion: "SPDX-2.3" }));
    expect(() => readSbomFile(filePath)).toThrow(/does not look like a CycloneDX document/i);
  });

  it("returns the raw content for a valid CycloneDX document", () => {
    const filePath = writeTempFile(VALID_CYCLONEDX);
    expect(readSbomFile(filePath)).toBe(VALID_CYCLONEDX);
  });
});

describe("uploadSbom", () => {
  const baseOptions = {
    portalUrl: "https://sbom.example.com",
    apiKey: "test-key",
    projectName: "chronopay-backend",
    projectVersion: "v1.2.3",
    sbomContent: VALID_CYCLONEDX,
    retryDelayMs: 0,
    sleepImpl: async () => {},
  };

  it("succeeds on the first attempt", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
    const result = await uploadSbom({ ...baseOptions, fetchImpl });

    expect(result).toEqual({ success: true, status: 200, attempts: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://sbom.example.com/api/v1/bom");
    expect((init as RequestInit).headers).toMatchObject({ "X-Api-Key": "test-key" });
  });

  it("retries on a transient network error and eventually succeeds (portal recovering)", async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await uploadSbom({ ...baseOptions, fetchImpl, maxRetries: 3 });

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries when the portal is down", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await uploadSbom({ ...baseOptions, fetchImpl, maxRetries: 3 });

    expect(result.success).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.error).toMatch(/unreachable after 3 attempts/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails fast on a 4xx response without retrying (e.g. bad API key)", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 401 } as Response);
    const result = await uploadSbom({ ...baseOptions, fetchImpl, maxRetries: 3 });

    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries on a 5xx response", async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200 } as Response);

    const result = await uploadSbom({ ...baseOptions, fetchImpl, maxRetries: 3 });

    expect(result.success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
