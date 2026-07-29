// src/services/fraudScorer.ts
import { createHash } from "crypto";
import type { Request } from "express";

export interface FraudCase {
  type: "sockpuppet_review";
  score: number;
  actors: string[];
  reason: string;
  evidence: {
    ip: string;
    fingerprintHash: string;
    actors: string[];
    observedAt: string;
  };
}

export interface FraudEvaluationResult {
  score: number;
  reasons: string[];
  case?: FraudCase;
  snapshot?: FraudFeatureSnapshot;
}

export interface FraudFeatureVector {
  actorId: string;
  observedIp: string;
  fingerprintHash?: string;
  velocityCount: number;
  hasHeaderFp: boolean;
  hasStoredFp: boolean;
  fingerprintMismatch: boolean;
  disposableEmail: boolean;
  sharedIp: boolean;
  sharedFingerprint: boolean;
  emailDomain?: string;
}

export interface FraudFeatureSnapshot {
  snapshotId: string;
  tenantId: string;
  intentId: string;
  specVersion: string;
  featureHash: string;
  features: FraudFeatureVector;
  timestamp: string;
  sampled: boolean;
}

export interface FeatureSnapshotWriter {
  writeSnapshot(snapshot: FraudFeatureSnapshot): Promise<void>;
}

/** Simple in-memory tracker for request timestamps per actor */
class VelocityTracker {
  private readonly windows = new Map<string, number[]>();
  constructor(private readonly windowMs: number) {}
  record(actorId: string): number {
    const now = Date.now();
    const timestamps = this.windows.get(actorId) ?? [];
    const valid = timestamps.filter((t) => now - t <= this.windowMs);
    valid.push(now);
    this.windows.set(actorId, valid);
    return valid.length;
  }
}

export class FraudScorer {
  private readonly velocityWindowMs: number =
    Number(process.env.FRAUD_VELOCITY_WINDOW_MS) || 60_000;
  private readonly maxIntents: number =
    Number(process.env.FRAUD_MAX_INTENTS) || 5;
  private readonly stepUpMode: "challenge" | "quarantine" =
    (process.env.FRAUD_STEP_UP_MODE as any) || "challenge";
  private readonly disposableList: Set<string> = new Set(
    (
      process.env.FRAUD_DISPOSABLE_LIST ||
      "mailinator.com,trashmail.com,tempmail.com"
    )
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  private readonly threshold: number =
    Number(process.env.FRAUD_STEP_UP_THRESHOLD) || 2;
  private readonly velocityTracker = new VelocityTracker(this.velocityWindowMs);
  private readonly ipIndex = new Map<string, Set<string>>();
  private readonly fingerprintIndex = new Map<string, Set<string>>();

  private specVersion: string =
    process.env.FRAUD_FEATURE_SPEC_VERSION || "v1.0.0";
  private defaultSamplingRate: number =
    process.env.FRAUD_FEATURE_SAMPLING_RATE !== undefined
      ? Number(process.env.FRAUD_FEATURE_SAMPLING_RATE)
      : 1.0;
  private readonly tenantSamplingRates = new Map<string, number>();

  constructor(
    private readonly snapshotWriter?: FeatureSnapshotWriter,
    options?: {
      specVersion?: string;
      defaultSamplingRate?: number;
    },
  ) {
    if (options?.specVersion) {
      this.specVersion = options.specVersion;
    }
    if (options?.defaultSamplingRate !== undefined) {
      this.defaultSamplingRate = options.defaultSamplingRate;
    }
  }

  evaluate(intentId: string, req: Request): FraudEvaluationResult {
    const reasons: string[] = [];
    const actorId = (req as any).auth?.userId || "anonymous";
    const observedIp = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const headerFp = req.headers["x-device-fingerprint"] as string | undefined;
    const storedFp = (req as any).auth?.fingerprint as string | undefined;
    const fingerprintValue = headerFp ?? storedFp ?? "";
    const fingerprintHash = fingerprintValue
      ? this.hashFingerprint(fingerprintValue)
      : undefined;

    const tenantId =
      (req as any).tenantId ||
      (req.headers["x-tenant-id"] as string) ||
      "default_tenant";

    // Velocity check
    const count = this.velocityTracker.record(actorId);
    if (count > this.maxIntents) {
      reasons.push("velocity_exceeded");
    }

    // Fingerprint / User-agent mismatch (header vs stored)
    const fingerprintMismatch = Boolean(headerFp && storedFp && headerFp !== storedFp);
    if (fingerprintMismatch) {
      reasons.push("fingerprint_mismatch");
    }

    // Disposable email detection
    const email = (req.body as any)?.email as string | undefined;
    const emailDomain = email ? email.split("@")[1]?.toLowerCase() : undefined;
    const isDisposable = Boolean(emailDomain && this.disposableList.has(emailDomain));
    if (isDisposable) {
      reasons.push("disposable_email");
    }

    let caseDetails: FraudCase | undefined;
    let sharedIp = false;
    let sharedFingerprint = false;

    if (observedIp && fingerprintHash) {
      const ipActors = this.ipIndex.get(observedIp) ?? new Set<string>();
      const fingerprintActors =
        this.fingerprintIndex.get(fingerprintHash) ?? new Set<string>();
      sharedIp = Array.from(ipActors).some(
        (existingActor) => existingActor !== actorId,
      );
      sharedFingerprint = Array.from(fingerprintActors).some(
        (existingActor) => existingActor !== actorId,
      );

      if (sharedIp) {
        reasons.push("shared_ip");
      }
      if (sharedFingerprint) {
        reasons.push("shared_fingerprint");
      }

      if (sharedIp && sharedFingerprint) {
        const combinedActors = Array.from(
          new Set([actorId, ...ipActors, ...fingerprintActors]),
        );
        caseDetails = {
          type: "sockpuppet_review",
          score: 5,
          actors: combinedActors,
          reason: "shared_ip_and_fingerprint",
          evidence: {
            ip: observedIp,
            fingerprintHash,
            actors: combinedActors,
            observedAt: new Date().toISOString(),
          },
        };
      }

      ipActors.add(actorId);
      fingerprintActors.add(actorId);
      this.ipIndex.set(observedIp, ipActors);
      this.fingerprintIndex.set(fingerprintHash, fingerprintActors);
    }

    // Feature vector & snapshot creation
    const featureVector: FraudFeatureVector = {
      actorId,
      observedIp,
      fingerprintHash,
      velocityCount: count,
      hasHeaderFp: Boolean(headerFp),
      hasStoredFp: Boolean(storedFp),
      fingerprintMismatch,
      disposableEmail: isDisposable,
      sharedIp,
      sharedFingerprint,
      emailDomain,
    };

    const currentSpecVersion = this.specVersion;
    const featureHash = this.hashFeatureVector(
      currentSpecVersion,
      featureVector,
    );

    const samplingRate = this.getTenantSamplingRate(tenantId);
    const sampled = samplingRate > 0 && (samplingRate >= 1.0 || Math.random() < samplingRate);

    const snapshotId = `snap_${createHash("sha256")
      .update(intentId + ":" + Date.now())
      .digest("hex")
      .substring(0, 12)}`;

    const snapshot: FraudFeatureSnapshot = {
      snapshotId,
      tenantId,
      intentId,
      specVersion: currentSpecVersion,
      featureHash,
      features: featureVector,
      timestamp: new Date().toISOString(),
      sampled,
    };

    if (sampled && this.snapshotWriter) {
      // Async fanout to writer without blocking serving path
      Promise.resolve().then(async () => {
        try {
          await this.snapshotWriter!.writeSnapshot(snapshot);
        } catch {
          // Non-blocking catch for snapshot writer outage/errors
        }
      });
    }

    const score = reasons.length + (caseDetails ? 3 : 0);
    return { score, reasons, case: caseDetails, snapshot };
  }

  setSpecVersion(version: string): void {
    this.specVersion = version;
  }

  getSpecVersion(): string {
    return this.specVersion;
  }

  setTenantSamplingRate(tenantId: string, rate: number): void {
    this.tenantSamplingRates.set(tenantId, Math.max(0, Math.min(1, rate)));
  }

  getTenantSamplingRate(tenantId: string): number {
    return this.tenantSamplingRates.get(tenantId) ?? this.defaultSamplingRate;
  }

  hashFeatureVector(
    specVersion: string,
    features: FraudFeatureVector,
  ): string {
    return createHash("sha256")
      .update(`${specVersion}:${JSON.stringify(features)}`)
      .digest("hex");
  }

  private hashFingerprint(value: string): string {
    return createHash("sha256")
      .update(value.trim().toLowerCase())
      .digest("hex");
  }

  getThreshold(): number {
    return this.threshold;
  }

  getStepUpMode(): "challenge" | "quarantine" {
    return this.stepUpMode;
  }
}
