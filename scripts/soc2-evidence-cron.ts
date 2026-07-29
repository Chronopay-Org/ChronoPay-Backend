import { randomUUID } from "crypto";

export interface EvidenceSample {
  id: string;
  timestamp: string;
  event: string;
  actor: string;
  details: string;
}

export interface CollectionManifest {
  manifestId: string;
  collectionTimestamp: string;
  sampleCount: number;
  retentionPeriodDays: number;
  bucketUrl: string;
  objectLockEnabled: boolean;
  status: "SUCCESS" | "FAILED";
}

export interface SimulationOptions {
  simulateBucketDown?: boolean;
  simulateRetentionChange?: boolean;
  simulateOversizedSample?: boolean;
}

export class Soc2EvidenceCollector {
  private readonly MAX_SAMPLE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

  /**
   * Generates or fetches samples for the current collection cycle.
   * In a real system, this would query a logging backend or database.
   */
  public async collectSamples(): Promise<EvidenceSample[]> {
    // Generate some mock samples
    const samples: EvidenceSample[] = [];
    for (let i = 0; i < 10; i++) {
      samples.push({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        event: "UserLogin",
        actor: "user_" + Math.floor(Math.random() * 1000),
        details: this.redactPII("Login successful from IP 192.168.1.100, email: test@example.com"),
      });
    }
    return samples;
  }

  /**
   * Redacts sensitive information like emails, IPs, etc.
   */
  private redactPII(text: string): string {
    return text
      .replace(/\b[\w.-]+@[\w.-]+\.\w{2,4}\b/gi, "[REDACTED_EMAIL]")
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/gi, "[REDACTED_IP]");
  }

  /**
   * Simulates uploading the samples to an immutable bucket with object-lock.
   */
  public async uploadToBucket(
    payload: string,
    options: SimulationOptions = {}
  ): Promise<string> {
    const payloadSize = Buffer.byteLength(payload, "utf-8");

    if (options.simulateOversizedSample || payloadSize > this.MAX_SAMPLE_SIZE_BYTES) {
      throw new Error("Validation Error: Sample exceeds maximum allowed size limit.");
    }

    if (options.simulateBucketDown) {
      throw new Error("Network Error: Immutable storage bucket is currently unreachable.");
    }

    if (options.simulateRetentionChange) {
      throw new Error("Security Error: Object-lock retention policy validation failed.");
    }

    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 100));

    return `s3://soc2-compliance-bucket/evidence/${new Date().toISOString().split("T")[0]}/sample-${randomUUID()}.json`;
  }

  /**
   * Orchestrates the collection cycle.
   */
  public async runCycle(options: SimulationOptions = {}): Promise<CollectionManifest> {
    let manifest: CollectionManifest = {
      manifestId: randomUUID(),
      collectionTimestamp: new Date().toISOString(),
      sampleCount: 0,
      retentionPeriodDays: 365, // Aligned to 1-year audit window
      bucketUrl: "",
      objectLockEnabled: true,
      status: "FAILED",
    };

    try {
      const samples = await this.collectSamples();
      manifest.sampleCount = samples.length;

      const payload = JSON.stringify(samples, null, 2);
      
      const uploadUrl = await this.uploadToBucket(payload, options);
      
      manifest.bucketUrl = uploadUrl;
      manifest.status = "SUCCESS";
      
      console.log(`[SOC2 Cron] Successfully uploaded ${samples.length} samples to ${uploadUrl}`);
    } catch (error: any) {
      console.error(`[SOC2 Cron] Cycle failed: ${error.message}`);
      throw error;
    } finally {
      // Log the manifest for auditing purposes
      console.log(`[SOC2 Cron] Manifest: ${JSON.stringify(manifest)}`);
    }

    return manifest;
  }
}

// Entry point for manual execution
if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("soc2-evidence-cron.ts")) {
  const collector = new Soc2EvidenceCollector();
  collector.runCycle().catch(() => process.exit(1));
}
