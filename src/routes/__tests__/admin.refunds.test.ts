// @ts-nocheck
import request from "supertest";
import { createApp } from "../../app.js";
import { setRefundRepository, setSessionRepositoryForRefund } from "../../services/refund.js";
import { setCheckoutRepository } from "../../services/checkout.js";
import { CheckoutSessionStatus } from "../../types/checkout.js";

const app = createApp({ enableContentNegotiation: false });
const adminHeaders = { "x-chronopay-admin-token": "test-admin-token" };

class InMemoryRefundRepo {
  private store: Map<string, any> = new Map();

  async create(request: any): Promise<any> {
    const id = `refund-${this.store.size + 1}`;
    const now = Math.floor(Date.now() / 1000);
    const entry = {
      id,
      paymentId: request.paymentId,
      amountCents: request.amountCents,
      currency: request.currency ?? "USD",
      reason: request.reason ?? null,
      status: "completed" as const,
      refundedBy: request.refundedBy ?? null,
      createdAt: now,
    };
    this.store.set(id, entry);
    return this.mapRow(entry);
  }

  async findByPaymentId(paymentId: string): Promise<any[]> {
    return Array.from(this.store.values())
      .filter((e) => e.paymentId === paymentId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async sumRefundedCents(paymentId: string): Promise<number> {
    return Array.from(this.store.values())
      .filter((e) => e.paymentId === paymentId)
      .reduce((sum, e) => sum + e.amountCents, 0);
  }

  async findById(id: string): Promise<any | null> {
    return this.store.get(id) ?? null;
  }

  private mapRow(row: any): any {
    return {
      id: row.id,
      paymentId: row.paymentId,
      amountCents: row.amountCents,
      currency: row.currency ?? "USD",
      reason: row.reason ?? undefined,
      status: row.status,
      refundedBy: row.refundedBy ?? undefined,
      createdAt: typeof row.createdAt === "number" ? row.createdAt : Math.floor(new Date(row.createdAt as string).getTime() / 1000),
    };
  }
}

class InMemorySessionRepo {
  private store: Map<string, any> = new Map();

  async create(session: any): Promise<any> {
    this.store.set(session.id, { ...session });
    return session;
  }

  async findById(id: string): Promise<any | null> {
    return this.store.get(id) ?? null;
  }

  async updateSession(id: string, fields: any): Promise<any> {
    const session = this.store.get(id);
    if (!session) throw new Error("Not found");
    Object.assign(session, fields);
    return session;
  }
}

describe("Refund Routes", () => {
  let refundRepo: InMemoryRefundRepo;
  let sessionRepo: InMemorySessionRepo;

  beforeEach(() => {
    process.env.CHRONOPAY_ADMIN_TOKEN = "test-admin-token";
    refundRepo = new InMemoryRefundRepo();
    sessionRepo = new InMemorySessionRepo();
    setRefundRepository(refundRepo);
    setSessionRepositoryForRefund(sessionRepo);
    setCheckoutRepository(sessionRepo);
  });

  afterEach(() => {
    delete process.env.CHRONOPAY_ADMIN_TOKEN;
  });

  describe("POST /api/v1/admin/refunds", () => {
    it("requires admin token", async () => {
      const res = await request(app).post("/api/v1/admin/refunds").send({});
      expect(res.status).toBe(401);
    });

    it("returns 400 when paymentId is missing", async () => {
      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ amountCents: 100 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("paymentId");
    });

    it("returns 400 when amountCents is invalid", async () => {
      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "p1", amountCents: 0 });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("amountCents");
    });

    it("returns 404 when payment session does not exist", async () => {
      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "nonexistent", amountCents: 100 });
      expect(res.status).toBe(404);
    });

    it("returns 409 when payment session is not completed", async () => {
      await sessionRepo.create({
        id: "session-pending",
        payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.PENDING,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });

      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-pending", amountCents: 100 });
      expect(res.status).toBe(409);
      expect(res.body.error).toContain("pending");
    });

    it("creates a refund for a completed session", async () => {
      await sessionRepo.create({
        id: "session-completed",
        payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.COMPLETED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });

      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-completed", amountCents: 300, reason: "partial refund" });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.refund.paymentId).toBe("session-completed");
      expect(res.body.refund.amountCents).toBe(300);
      expect(res.body.refund.reason).toBe("partial refund");
      expect(res.body.refund.id).toBeDefined();
    });

    it("rejects refund that exceeds remaining amount", async () => {
      await sessionRepo.create({
        id: "session-exceed",
        payment: { amount: 500, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.COMPLETED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });

      const res = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-exceed", amountCents: 600 });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe("REFUND_EXCEEDS_REMAINING");
    });

    it("allows multiple partial refunds up to the captured amount", async () => {
      await sessionRepo.create({
        id: "session-multi",
        payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.COMPLETED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });

      const r1 = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-multi", amountCents: 300 });
      expect(r1.status).toBe(201);

      const r2 = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-multi", amountCents: 400 });
      expect(r2.status).toBe(201);

      const r3 = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-multi", amountCents: 300 });
      expect(r3.status).toBe(201);

      const r4 = await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-multi", amountCents: 1 });
      expect(r4.status).toBe(422);
      expect(r4.body.code).toBe("REFUND_EXCEEDS_REMAINING");
    });
  });

  describe("GET /api/v1/admin/payments/:id/trace", () => {
    it("requires admin token", async () => {
      const res = await request(app).get("/api/v1/admin/payments/p1/trace");
      expect(res.status).toBe(401);
    });

    it("returns 404 for non-existent payment", async () => {
      const res = await request(app)
        .get("/api/v1/admin/payments/nonexistent/trace")
        .set(adminHeaders);
      expect(res.status).toBe(404);
    });

    it("returns trace with payment and refunds", async () => {
      await sessionRepo.create({
        id: "session-trace",
        payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.COMPLETED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });

      await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-trace", amountCents: 200, reason: "first" });
      await request(app)
        .post("/api/v1/admin/refunds")
        .set(adminHeaders)
        .send({ paymentId: "session-trace", amountCents: 300, reason: "second" });

      const res = await request(app)
        .get("/api/v1/admin/payments/session-trace/trace")
        .set(adminHeaders);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.trace.payment.amountCents).toBe(1000);
      expect(res.body.trace.refunds).toHaveLength(2);
      expect(res.body.trace.totalRefundedCents).toBe(500);
      expect(res.body.trace.remainingCents).toBe(500);
    });

    it("returns trace with zero refunds when none exist", async () => {
      await sessionRepo.create({
        id: "session-no-refunds",
        payment: { amount: 500, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.COMPLETED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });

      const res = await request(app)
        .get("/api/v1/admin/payments/session-no-refunds/trace")
        .set(adminHeaders);
      expect(res.status).toBe(200);
      expect(res.body.trace.refunds).toHaveLength(0);
      expect(res.body.trace.totalRefundedCents).toBe(0);
      expect(res.body.trace.remainingCents).toBe(500);
    });
  });
});

describe("RefundService", () => {
  let refundRepo: InMemoryRefundRepo;
  let sessionRepo: InMemorySessionRepo;

  beforeEach(() => {
    refundRepo = new InMemoryRefundRepo();
    sessionRepo = new InMemorySessionRepo();
    setRefundRepository(refundRepo);
    setSessionRepositoryForRefund(sessionRepo);
    setCheckoutRepository(sessionRepo);
  });

  describe("createRefund", () => {
    it("throws when payment does not exist", async () => {
      const { RefundService } = await import("../../services/refund.js");
      await expect(
        RefundService.createRefund({ paymentId: "missing", amountCents: 100 }),
      ).rejects.toThrow();
    });

    it("throws when session is voided/cancelled", async () => {
      await sessionRepo.create({
        id: "cancelled",
        payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.CANCELLED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });
      const { RefundService } = await import("../../services/refund.js");
      await expect(
        RefundService.createRefund({ paymentId: "cancelled", amountCents: 100 }),
      ).rejects.toThrow("cancelled");
    });

    it("throws when refund amount exceeds captured", async () => {
      await sessionRepo.create({
        id: "s1",
        payment: { amount: 500, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.COMPLETED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });
      const { RefundService } = await import("../../services/refund.js");
      await expect(
        RefundService.createRefund({ paymentId: "s1", amountCents: 501 }),
      ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_REMAINING" });
    });
  });

  describe("getPaymentTrace", () => {
    it("throws for missing payment", async () => {
      const { RefundService } = await import("../../services/refund.js");
      await expect(
        RefundService.getPaymentTrace("missing"),
      ).rejects.toThrow();
    });

    it("returns trace with payment info", async () => {
      await sessionRepo.create({
        id: "t1",
        payment: { amount: 1000, currency: "USD", paymentMethod: "credit_card" },
        customer: { customerId: "c1", email: "a@b.com" },
        status: CheckoutSessionStatus.COMPLETED,
        createdAt: 1000,
        updatedAt: 1000,
        expiresAt: 999999,
      });
      const { RefundService } = await import("../../services/refund.js");
      const trace = await RefundService.getPaymentTrace("t1");
      expect(trace.payment.amountCents).toBe(1000);
      expect(trace.totalRefundedCents).toBe(0);
      expect(trace.remainingCents).toBe(1000);
    });
  });
});