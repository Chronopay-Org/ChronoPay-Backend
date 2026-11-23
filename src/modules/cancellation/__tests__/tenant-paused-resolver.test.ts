/**
 * Tenant-paused resolver — lifecycle and integration coverage (issue #1140).
 *
 * `appendEntry` must honour the tenant kill-switch wired at bootstrap via
 * `setTenantPausedResolver`. This suite pins:
 *   - the documented fail-open default and the getter;
 *   - validation of the wired function (rejected values are no-ops);
 *   - `resetTenantPausedResolver` restoring the default;
 *   - the end-to-end contract: a service with no explicit `isTenantPaused`
 *     dependency consults the module resolver, rejects with
 *     `TenantPausedError`, and persists no row;
 *   - an explicit per-service dependency still overrides the module resolver.
 */

import { jest, afterEach, describe, expect, it } from "@jest/globals";
import type { InsertCancellationReversalInput } from "../../../types/cancellationReversal.js";
import {
  CancellationReversalService,
  TenantPausedError,
  getTenantPausedResolver,
  resetTenantPausedResolver,
  setTenantPausedResolver,
} from "../cancellation-reversal-service.js";
import { InMemoryCancellationReversalRepository } from "../pg-cancellation-reversal-repository.js";

jest.mock("../../../services/auditLogger.js", () => ({
  defaultAuditLogger: {
    log: jest.fn().mockResolvedValue(undefined as never),
  },
}));

function makeInput(
  overrides: Partial<InsertCancellationReversalInput> = {},
): InsertCancellationReversalInput {
  return {
    bookingIntentId: "intent-1",
    paymentId: "pay-USD-A",
    originalRefundId: "refund-1",
    amountCents: -1500,
    currency: "USD",
    escrowReleased: false,
    escrowReleasedAmountCents: 0,
    reason: "prorated_cancellation",
    idempotencyKey: "idem-1",
    policyVersionId: "v2-prorated",
    actor: "user-1",
    metadata: { tenantId: "tenant-A" },
    ...overrides,
  };
}

/** A service with NO explicit tenant-paused dependency. */
function buildService() {
  const repo = new InMemoryCancellationReversalRepository();
  const checkoutSessionLookup = {
    async getCurrency(paymentId: string) {
      return paymentId === "pay-USD-A" ? ("USD" as const) : null;
    },
  };
  const service = new CancellationReversalService({
    repo,
    checkoutSessionLookup,
    netRefundLookup: {
      async getNetRefund() {
        return 1500;
      },
    },
    now: () => new Date("2026-02-01T00:00:00Z"),
  });
  return { service, repo };
}

afterEach(() => {
  resetTenantPausedResolver();
});

describe("tenant-paused resolver lifecycle", () => {
  it("defaults to fail-open and is returned by the getter", () => {
    resetTenantPausedResolver();
    const resolver = getTenantPausedResolver();
    expect(typeof resolver).toBe("function");
    expect(resolver("any-tenant")).toBe(false);
  });

  it("wires a replacement resolver and exposes it via the getter", () => {
    const stub = (tenantId: string) => tenantId === "tenant-A";
    setTenantPausedResolver(stub);
    expect(getTenantPausedResolver()).toBe(stub);
    expect(getTenantPausedResolver()("tenant-A")).toBe(true);
    expect(getTenantPausedResolver()("tenant-B")).toBe(false);
  });

  it.each([[null], [undefined], ["not-a-function"], [42]])(
    "rejects a non-function resolver (%p) and leaves the previous one intact",
    (bad) => {
      const good = () => true;
      setTenantPausedResolver(good);
      expect(() => setTenantPausedResolver(bad as never)).toThrow(TypeError);
      expect(getTenantPausedResolver()).toBe(good);
    },
  );

  it("restores the fail-open default", () => {
    setTenantPausedResolver(() => true);
    expect(getTenantPausedResolver()("tenant-A")).toBe(true);

    resetTenantPausedResolver();
    expect(getTenantPausedResolver()("tenant-A")).toBe(false);
  });
});

describe("appendEntry honours the bootstrap-wired resolver", () => {
  it("rejects with TenantPausedError and persists no row when the tenant is paused", async () => {
    setTenantPausedResolver((tenantId) => tenantId === "tenant-A");
    const { service, repo } = buildService();

    await expect(service.appendEntry(makeInput())).rejects.toBeInstanceOf(TenantPausedError);

    const stored = await repo.findByPaymentId("pay-USD-A");
    expect(stored).toHaveLength(0);
  });

  it("allows the insert when the wired resolver reports the tenant is open", async () => {
    setTenantPausedResolver(() => false);
    const { service, repo } = buildService();

    const entry = await service.appendEntry(makeInput());

    expect(entry.id).toBeTruthy();
    expect(await repo.findByPaymentId("pay-USD-A")).toHaveLength(1);
  });

  it("scopes the guard to the entry's tenant id", async () => {
    setTenantPausedResolver((tenantId) => tenantId === "tenant-A");
    const { service } = buildService();

    // A different tenant on a different (looked-up) payment is unaffected.
    const other = makeInput({
      paymentId: "pay-USD-A",
      idempotencyKey: "idem-other",
      metadata: { tenantId: "tenant-B" },
    });

    await expect(service.appendEntry(other)).resolves.toBeTruthy();
  });

  it("lets an explicit per-service dependency override the module resolver", async () => {
    // Module says the tenant is paused...
    setTenantPausedResolver(() => true);

    const repo = new InMemoryCancellationReversalRepository();
    const service = new CancellationReversalService({
      repo,
      checkoutSessionLookup: {
        async getCurrency() {
          return "USD" as const;
        },
      },
      // ...but the explicit dependency wins.
      isTenantPaused: () => false,
      netRefundLookup: {
        async getNetRefund() {
          return 1500;
        },
      },
      now: () => new Date("2026-02-01T00:00:00Z"),
    });

    await expect(service.appendEntry(makeInput())).resolves.toBeTruthy();
  });

  it("starts rejecting after the resolver is wired mid-process", async () => {
    const { service } = buildService();

    await expect(service.appendEntry(makeInput({ idempotencyKey: "k1" }))).resolves.toBeTruthy();

    setTenantPausedResolver((tenantId) => tenantId === "tenant-A");

    await expect(
      service.appendEntry(makeInput({ idempotencyKey: "k2", amountCents: -200 })),
    ).rejects.toBeInstanceOf(TenantPausedError);
  });
});
