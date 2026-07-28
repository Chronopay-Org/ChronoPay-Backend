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
  private readonly velocityWindowMs: number = Number(process.env.FRAUD_VELOCITY_WINDOW_MS) || 60_000;
  private readonly maxIntents: number = Number(process.env.FRAUD_MAX_INTENTS) || 5;
  private readonly stepUpMode: "challenge" | "quarantine" = (process.env.FRAUD_STEP_UP_MODE as any) || "challenge";
  private readonly disposableList: Set<string> = new Set(
    (process.env.FRAUD_DISPOSABLE_LIST || "mailinator.com,trashmail.com,tempmail.com")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  private readonly threshold: number = Number(process.env.FRAUD_STEP_UP_THRESHOLD) || 2;
  private readonly velocityTracker = new VelocityTracker(this.velocityWindowMs);
  private readonly ipIndex = new Map<string, Set<string>>();
  private readonly fingerprintIndex = new Map<string, Set<string>>();

  evaluate(intentId: string, req: Request): FraudEvaluationResult {
    const reasons: string[] = [];
    const actorId = (req as any).auth?.userId || "anonymous";
    const observedIp = req.ip ?? req.socket?.remoteAddress ?? "unknown";
    const headerFp = req.headers["x-device-fingerprint"] as string | undefined;
    const storedFp = (req as any).auth?.fingerprint as string | undefined;
    const fingerprintValue = headerFp ?? storedFp ?? "";
    const fingerprintHash = fingerprintValue ? this.hashFingerprint(fingerprintValue) : undefined;

    // Velocity check
    const count = this.velocityTracker.record(actorId);
    if (count > this.maxIntents) {
      reasons.push("velocity_exceeded");
    }

    // Fingerprint / User-agent mismatch (header vs stored)
    if (headerFp && storedFp && headerFp !== storedFp) {
      reasons.push("fingerprint_mismatch");
    }

    // Disposable email detection
    const email = (req.body as any)?.email as string | undefined;
    if (email) {
      const domain = email.split("@")[1]?.toLowerCase() ?? "";
      if (this.disposableList.has(domain)) {
        reasons.push("disposable_email");
      }
    }

    let caseDetails: FraudCase | undefined;

    if (observedIp && fingerprintHash) {
      const ipActors = this.ipIndex.get(observedIp) ?? new Set<string>();
      const fingerprintActors = this.fingerprintIndex.get(fingerprintHash) ?? new Set<string>();
      const sharedIp = Array.from(ipActors).some((existingActor) => existingActor !== actorId);
      const sharedFingerprint = Array.from(fingerprintActors).some((existingActor) => existingActor !== actorId);

      if (sharedIp) {
        reasons.push("shared_ip");
      }
      if (sharedFingerprint) {
        reasons.push("shared_fingerprint");
      }

      if (sharedIp && sharedFingerprint) {
        const combinedActors = Array.from(new Set([actorId, ...ipActors, ...fingerprintActors]));
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

    const score = reasons.length + (caseDetails ? 3 : 0);
    return { score, reasons, case: caseDetails };
  }

  private hashFingerprint(value: string): string {
    return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
  }

  getThreshold(): number {
    return this.threshold;
  }
  getStepUpMode(): "challenge" | "quarantine" {
    return this.stepUpMode;
  }
}
