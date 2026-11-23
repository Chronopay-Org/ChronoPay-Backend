import { describe, it, expect, beforeEach } from "vitest";
import { describe, it, expect, beforeEach, vi } from "vitest";

import { RefundService } from "../services/refund";
import { AmountUtils } from "../utils/amount";

type PaymentRow = {
  id: string;
  currency: string;
  capturedCents: number;
};

type RefundRow = {
  id: string;
  paymentId: string;
  amountCents: number;
  currency: string;
};

interface QueryResult<T> {
  rowCount: number;
  rows: T[];
}

interface TransactionalClient {
  query<T>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

class FakeTransactionalDb {
  private payments: Map<string, PaymentRow> = new Map();
  private refunds: RefundRow[] = [];
  private lockQueue: Promise<void> = Promise.resolve();
  private locked: boolean = false;

  seedPayment(payment: PaymentRow): void {
    this.payments.set(payment.id, { ...payment });
  }

  getRefunds(): RefundRow[] {
    return this.refunds.map((r) => ({ ...r }));
  }

  getPayment(id: string): PaymentRow | undefined {
    const row = this.payments.get(id);
    return row ? { ...row } : undefined;
  }

  async withTransaction<T>(
    fn: (client: TransactionalClient) => Promise<T>,
  ): Promise<T> {
    const previous = this.lockQueue;
    let release: () => void = () => {};
    this.lockQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    this.locked = true;
    try {
      const client: TransactionalClient = {
        query: <R>(sql: string, params: unknown[] = []) =>
          this.execute<R>(sql, params),
      };
      return await fn(client);
    } finally {
      this.locked = false;
      release();
    }
  }

  private async execute<R>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();

    if (normalized.startsWith("select") && normalized.includes("from checkout_sessions")) {
      const paymentId = String(params[0]);
      const payment = this.payments.get(paymentId);
      if (!payment) {
        return { rowCount: 0, rows: [] };
      }
      return {
        rowCount: 1,
        rows: [{ ...payment } as unknown as R],
      };
    }

    if (normalized.startsWith("select") && normalized.includes("coalesce(sum")) {
      const paymentId = String(params[0]);
      const total = this.refunds
        .filter((r) => r.paymentId === paymentId)
        .reduce((sum, r) => sum + r.amountCents, 0);
      return {
        rowCount: 1,
        rows: [{ totalCents: total } as unknown as R],
      };
    }

    if (normalized.startsWith("insert into refunds")) {
      const [id, paymentId, amountCents, currency] = params;
      const row: RefundRow = {
        id: String(id),
        paymentId: String(paymentId),
        amountCents: Number(amountCents),
        currency: String(currency),
      };
      this.refunds.push(row);
      return {
        rowCount: 1,
        rows: [{ ...row } as unknown as R],
      };
    }

    throw new Error(`Unexpected query in fake transactional db: ${sql}`);
  }
}

describe("RefundService concurrency and validation", () => {
  let db: FakeTransactionalDb;
  let service: RefundService;

  beforeEach(() => {
    db = new FakeTransactionalDb();
    db.seedPayment({
      id: "pay_1",
      currency: "usd",
      capturedCents: 1000,
    });
    service = new RefundService(db as unknown as any);
  });

  it("allows two sequential refunds that fit within the captured amount", async () => {
    const a = await service.createRefund({
      paymentId: "pay_1",
      amountCents: 400,
      currency: "usd",
    });
    const b = await service.createRefund({
      paymentId: "pay_1",
      amountCents: 600,
      currency: "usd",
    });

    expect(a.amountCents).toBe(400);
    expect(b.amountCents).toBe(600);
    expect(db.getRefunds()).toHaveLength(2);
  });

  it("rejects a single refund exceeding the captured amount", async () => {
    await expect(
      service.createRefund({
        paymentId: "pay_1",
        amountCents: 1001,
        currency: "usd",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.getRefunds()).toHaveLength(0);
  });

  it("serialises concurrent refunds so only one succeeds when they overflow collectively", async () => {
    const results = await Promise.allSettled([
      service.createRefund({
        paymentId: "pay_1",
        amountCents: 700,
        currency: "usd",
      }),
      service.createRefund({
        paymentId: "pay_1",
        amountCents: 700,
        currency: "usd",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ status: 422 });
    expect(db.getRefunds()).toHaveLength(1);
    expect(db.getRefunds()[0].amountCents).toBe(700);
  });

  it("rejects non-integer amountCents", async () => {
    await expect(
      service.createRefund({
        paymentId: "pay_1",
        amountCents: 10.5 as unknown as number,
        currency: "usd",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(db.getRefunds()).toHaveLength(0);
  });

  it("rejects a currency that differs from the payment currency", async () => {
    await expect(
      service.createRefund({
        paymentId: "pay_1",
        amountCents: 100,
        currency: "eur",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(db.getRefunds()).toHaveLength(0);
  });

  it("rejects an unknown payment", async () => {
    await expect(
      service.createRefund({
        paymentId: "pay_missing",
        amountCents: 100,
        currency: "usd",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("validates amounts with AmountUtils.validate", () => {
    expect(() => AmountUtils.validate(10.5)).toThrow();
    expect(() => AmountUtils.validate(0)).toThrow();
    expect(() => AmountUtils.validate(-1)).toThrow();
    expect(AmountUtils.validate(100)).toBe(100);
  });
});
