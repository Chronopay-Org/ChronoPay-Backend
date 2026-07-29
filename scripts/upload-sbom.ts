/**
 * Uploads a CycloneDX SBOM to the supply-chain security portal.
 *
 * Targets the Dependency-Track `POST /api/v1/bom` upload API
 * (https://docs.dependencytrack.org/integrations/rest-api/), which is
 * CycloneDX-native and the most common self-hosted target for this kind
 * of upload. Point `SBOM_PORTAL_URL` at any Dependency-Track-compatible
 * endpoint.
 *
 * Usage: tsx scripts/upload-sbom.ts [--file <sbom.cyclonedx.json>]
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isMainModule = typeof process !== "undefined" && process.argv[1] === fileURLToPath(import.meta.url);

export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_RETRY_DELAY_MS = 2000;

export class SbomFileError extends Error {}

/**
 * Reads and sanity-checks the SBOM file before upload.
 *
 * Catches the case where SBOM generation silently produced an empty or
 * malformed document (e.g. from an unresolved dependency) so we fail the
 * upload step with a clear message instead of sending an invalid BOM to
 * the portal.
 */
export function readSbomFile(path: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    throw new SbomFileError(`SBOM file not found at "${path}". Run \`npm run sbom\` first.`);
  }

  if (!raw.trim()) {
    throw new SbomFileError(`SBOM file at "${path}" is empty.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SbomFileError(`SBOM file at "${path}" is not valid JSON.`);
  }

  const bomFormat = (parsed as { bomFormat?: string } | null)?.bomFormat;
  if (bomFormat !== "CycloneDX") {
    throw new SbomFileError(
      `SBOM file at "${path}" does not look like a CycloneDX document (bomFormat: ${String(bomFormat)}).`,
    );
  }

  return raw;
}

export interface UploadSbomOptions {
  portalUrl: string;
  apiKey: string;
  projectName: string;
  projectVersion: string;
  sbomContent: string;
  maxRetries?: number;
  retryDelayMs?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests to avoid real sleeps. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export interface UploadSbomResult {
  success: boolean;
  status?: number;
  attempts: number;
  error?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Uploads the SBOM to the portal, retrying on network errors or 5xx
 * responses (transient "portal down" conditions) with linear backoff.
 * 4xx responses (bad API key, malformed request) fail fast without
 * retrying, since retrying won't help.
 */
export async function uploadSbom(options: UploadSbomOptions): Promise<UploadSbomResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? defaultSleep;

  const body = JSON.stringify({
    projectName: options.projectName,
    projectVersion: options.projectVersion,
    autoCreate: true,
    bom: Buffer.from(options.sbomContent, "utf8").toString("base64"),
  });

  let lastError = "";

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const res = await doFetch(`${options.portalUrl.replace(/\/$/, "")}/api/v1/bom`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Api-Key": options.apiKey,
        },
        body,
      });

      if (res.ok) {
        return { success: true, status: res.status, attempts: attempt };
      }

      // Client errors (bad API key, malformed payload) won't be fixed by
      // retrying — fail fast instead of hammering the portal.
      if (res.status >= 400 && res.status < 500) {
        return {
          success: false,
          status: res.status,
          attempts: attempt,
          error: `Portal rejected the upload (HTTP ${res.status}). Check SBOM_PORTAL_API_KEY.`,
        };
      }

      lastError = `Portal returned HTTP ${res.status}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (attempt < maxRetries) {
      await sleep(retryDelayMs * attempt);
    }
  }

  return {
    success: false,
    attempts: maxRetries,
    error: `Portal unreachable after ${maxRetries} attempts: ${lastError}`,
  };
}

if (isMainModule) {
  const fileArgIndex = process.argv.indexOf("--file");
  const sbomFile = fileArgIndex !== -1 ? process.argv[fileArgIndex + 1] : "sbom.cyclonedx.json";

  const portalUrl = process.env.SBOM_PORTAL_URL;
  const apiKey = process.env.SBOM_PORTAL_API_KEY;

  if (!portalUrl || !apiKey) {
    console.log("[sbom-upload] SBOM_PORTAL_URL / SBOM_PORTAL_API_KEY not set — skipping portal upload.");
    process.exit(0);
  }

  (async () => {
    let sbomContent: string;
    try {
      sbomContent = readSbomFile(sbomFile);
    } catch (err) {
      console.error(err instanceof SbomFileError ? err.message : err);
      process.exit(1);
      return;
    }

    const result = await uploadSbom({
      portalUrl,
      apiKey,
      projectName: process.env.npm_package_name ?? "chronopay-backend",
      projectVersion: process.env.GITHUB_REF_NAME ?? process.env.npm_package_version ?? "unknown",
      sbomContent,
    });

    if (!result.success) {
      console.error(`[sbom-upload] Upload failed: ${result.error}`);
      process.exit(1);
    }

    console.log(`[sbom-upload] Uploaded ${sbomFile} to ${portalUrl} (attempt ${result.attempts}, HTTP ${result.status}).`);
  })();
}
