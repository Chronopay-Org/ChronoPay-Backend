// src/services/fraudScorer.ts
import type { Request } from "express";

/** Simple in‑memory tracker for request timestamps per actor */
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
    (process.env.FRAUD_DISPOSABLE_LIST || "mailinator.com,trashmail.com,tempmail.com").
      split(",").
      map((s) => s.trim().toLowerCase()).
      filter(Boolean),
  );
  private readonly threshold: number = Number(process.env.FRAUD_STEP_UP_THRESHOLD) || 2;
  private readonly velocityTracker = new VelocityTracker(this.velocityWindowMs);

  evaluate(intentId: string, req: Request): { score: number; reasons: string[] } {
    const reasons: string[] = [];
    const actorId = (req as any).auth?.userId || "anonymous";

    // Velocity check
    const count = this.velocityTracker.record(actorId);
    if (count > this.maxIntents) {
      reasons.push("velocity_exceeded");
    }

    // Fingerprint / User‑Agent mismatch (header vs stored)
    const headerFp = req.headers["x-device-fingerprint"] as string | undefined;
    const storedFp = (req as any).auth?.fingerprint as string | undefined;
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

    const score = reasons.length;
    return { score, reasons };
  }

  getThreshold(): number { return this.threshold; }
  getStepUpMode(): "challenge" | "quarantine" { return this.stepUpMode; }
}
