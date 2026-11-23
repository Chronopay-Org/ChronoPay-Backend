import { Soc2EvidenceCollector } from "../soc2-evidence-cron.js";

describe("Soc2EvidenceCollector", () => {
  let collector: Soc2EvidenceCollector;

  beforeEach(() => {
    collector = new Soc2EvidenceCollector();
  });

  it("should successfully collect and redact samples", async () => {
    const samples = await collector.collectSamples();
    expect(samples.length).toBeGreaterThan(0);
    
    // Check redaction
    const sample = samples[0];
    expect(sample.details).toContain("[REDACTED_IP]");
    expect(sample.details).toContain("[REDACTED_EMAIL]");
    expect(sample.details).not.toContain("192.168.1.100");
    expect(sample.details).not.toContain("test@example.com");
  });

  it("should successfully run a collection cycle", async () => {
    const manifest = await collector.runCycle();
    
    expect(manifest.status).toBe("SUCCESS");
    expect(manifest.sampleCount).toBe(10);
    expect(manifest.objectLockEnabled).toBe(true);
    expect(manifest.retentionPeriodDays).toBe(365);
    expect(manifest.bucketUrl).toContain("s3://soc2-compliance-bucket");
  });

  it("should throw error when bucket is down", async () => {
    await expect(collector.runCycle({ simulateBucketDown: true }))
      .rejects.toThrow("Network Error: Immutable storage bucket is currently unreachable.");
  });

  it("should throw error when retention validation fails", async () => {
    await expect(collector.runCycle({ simulateRetentionChange: true }))
      .rejects.toThrow("Security Error: Object-lock retention policy validation failed.");
  });

  it("should throw error when sample is oversized", async () => {
    await expect(collector.runCycle({ simulateOversizedSample: true }))
      .rejects.toThrow("Validation Error: Sample exceeds maximum allowed size limit.");
  });
});
