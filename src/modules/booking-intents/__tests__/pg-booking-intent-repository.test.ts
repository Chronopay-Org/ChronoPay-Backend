import { jest } from "@jest/globals";
import { PgBookingIntentRepository } from "../pg-booking-intent-repository.js";
import { ConflictError, NotFoundError } from "../../../errors/AppError.js";
import type { BookingIntentRepository } from "../booking-intent-repository.js";
import type { QueryResult } from "pg";

describe("PgBookingIntentRepository", () => {
  let repository: PgBookingIntentRepository;
  let mockQuery: jest.Mock<(text: string, params?: any[]) => Promise<QueryResult>>;

  beforeEach(() => {
    mockQuery = jest.fn<(text: string, params?: any[]) => Promise<QueryResult>>();
    repository = new PgBookingIntentRepository(mockQuery as any);
  });

  const dbRow = {
    id: "intent-uuid",
    slot_id: "slot-123",
    professional_id: "prof-456",
    customer_id: "cust-789",
    start_time: new Date(1000),
    end_time: new Date(2000),
    status: "pending",
    note: "test note",
    token_asset: "ASSET_123",
    mint_tx_hash: "TX_HASH_123",
    created_at: new Date("2026-01-01T00:00:00.000Z"),
    booking_type: "standard",
    hold_until_ms: null,
    hold_placed_at: null,
    refunded_at: null,
    refund_metadata: null,
    pricing_snapshot: null,
    cancellation_policy_snapshot: null,
    hold_fee_policy_snapshot: null,
  };

  const expectedRecord = {
    id: "intent-uuid",
    slotId: "slot-123",
    professional: "prof-456",
    customerId: "cust-789",
    startTime: 1000,
    endTime: 2000,
    status: "pending",
    note: "test note",
    tokenAsset: "ASSET_123",
    mintTxHash: "TX_HASH_123",
    createdAt: "2026-01-01T00:00:00.000Z",
    bookingType: "standard",
    holdUntilMs: undefined,
    holdPlacedAt: undefined,
    refundedAt: undefined,
    refundMetadata: undefined,
    pricingSnapshot: undefined,
    cancellationPolicySnapshot: undefined,
    holdFeePolicySnapshot: undefined,
  };

  describe("create", () => {
    it("inserts a new booking intent and returns the mapped record", async () => {
      const intentData = {
        slotId: "slot-123",
        professional: "prof-456",
        customerId: "cust-789",
        startTime: 1000,
        endTime: 2000,
        status: "pending" as const,
        note: "test note",
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.create(intentData);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO booking_intents"),
        [
          intentData.slotId,
          intentData.professional,
          intentData.customerId,
          new Date(intentData.startTime),
          new Date(intentData.endTime),
          intentData.status,
          intentData.note,
          new Date(intentData.createdAt),
          "standard",     // booking_type
          null,            // hold_until_ms
          null,            // hold_placed_at
          null,            // refunded_at
          null,            // refund_metadata
          null,            // pricing_snapshot
          null,            // cancellation_policy_snapshot
          null,            // hold_fee_policy_snapshot
        ]
      );

      expect(result).toEqual(expectedRecord);
    });

    it("inserts with hold and snapshot fields when provided", async () => {
      const holdPlacedAtIso = "2026-01-01T10:00:00.000Z";
      const pricingSnapshot = {
        strategyId: "fixed" as const,
        resolvedPrice: 5000,
        basePrice: 5000,
        slotStartMs: 1000000,
        nowMs: 500000,
        activeBookings: 1,
        capacity: 10,
        config: {},
      };
      const holdFeePolicySnapshot = {
        supplierId: "supp-1",
        holdFeeCents: 200,
        capturedAtMs: 500000,
      };

      const intentData = {
        slotId: "slot-123",
        professional: "prof-456",
        customerId: "cust-789",
        startTime: 1000,
        endTime: 2000,
        status: "hold_placed" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        bookingType: "refundable_hold" as const,
        holdUntilMs: 200000,
        holdPlacedAt: holdPlacedAtIso,
        pricingSnapshot,
        holdFeePolicySnapshot,
      };

      const dbRowWithHold = {
        ...dbRow,
        status: "hold_placed",
        booking_type: "refundable_hold",
        hold_until_ms: 200000,
        hold_placed_at: new Date(holdPlacedAtIso),
        pricing_snapshot: pricingSnapshot,
        hold_fee_policy_snapshot: holdFeePolicySnapshot,
      };

      mockQuery.mockResolvedValueOnce({ rows: [dbRowWithHold], rowCount: 1 } as any);

      const result = await repository.create(intentData);

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO booking_intents"),
        expect.arrayContaining([
          "slot-123",
          "prof-456",
          "cust-789",
          new Date(1000),
          new Date(2000),
          "hold_placed",
          null,
          new Date("2026-01-01T00:00:00.000Z"),
          "refundable_hold",
          200000,
          new Date(holdPlacedAtIso),
          null,
          null,
          pricingSnapshot,
          null,
          holdFeePolicySnapshot,
        ])
      );

      expect(result.bookingType).toBe("refundable_hold");
      expect(result.holdUntilMs).toBe(200000);
      expect(result.holdPlacedAt).toBe(holdPlacedAtIso);
      expect(result.pricingSnapshot).toEqual(pricingSnapshot);
      expect(result.holdFeePolicySnapshot).toEqual(holdFeePolicySnapshot);
    });

    it("throws ConflictError when postgres reports a unique_violation (23505)", async () => {
      const pgUniqueViolation = Object.assign(new Error("duplicate key value"), {
        code: "23505",
      });
      mockQuery.mockRejectedValueOnce(pgUniqueViolation);

      const intentData = {
        slotId: "slot-123",
        professional: "prof-456",
        customerId: "cust-789",
        startTime: 1000,
        endTime: 2000,
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(repository.create(intentData)).rejects.toBeInstanceOf(ConflictError);
    });

    it("ConflictError from 23505 carries a 409 status code", async () => {
      const pgUniqueViolation = Object.assign(new Error("duplicate key value"), {
        code: "23505",
      });
      mockQuery.mockRejectedValueOnce(pgUniqueViolation);

      const intentData = {
        slotId: "slot-123",
        professional: "prof-456",
        customerId: "cust-789",
        startTime: 1000,
        endTime: 2000,
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      let caught: any;
      try {
        await repository.create(intentData);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ConflictError);
      expect(caught.statusCode).toBe(409);
      expect(caught.message).toMatch(/active booking intent/i);
    });

    it("re-throws non-23505 database errors unchanged", async () => {
      const dbError = Object.assign(new Error("connection timeout"), { code: "08006" });
      mockQuery.mockRejectedValueOnce(dbError);

      const intentData = {
        slotId: "slot-123",
        professional: "prof-456",
        customerId: "cust-789",
        startTime: 1000,
        endTime: 2000,
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      await expect(repository.create(intentData)).rejects.toThrow("connection timeout");
    });
  });

  describe("findById", () => {
    it("returns the record if found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.findById("intent-uuid");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM booking_intents WHERE id = $1"),
        ["intent-uuid"]
      );

      expect(result).toEqual(expectedRecord);
    });

    it("returns undefined if not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findById("unknown");

      expect(result).toBeUndefined();
    });
  });

  describe("updateTokenInfo", () => {
    it("updates token asset and tx hash", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      await repository.updateTokenInfo("intent-uuid", "ASSET", "TXHASH");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("UPDATE booking_intents"),
        ["intent-uuid", "ASSET", "TXHASH"]
      );
    });
  });

  // ─── findBySlotId: status filter ──────────────────────────────────────────

  describe("findBySlotId", () => {
    it("returns the record if found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.findBySlotId("slot-123");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM booking_intents WHERE slot_id = $1"),
        ["slot-123"]
      );

      expect(result).toEqual(expectedRecord);
    });

    it("includes status IN ('pending','hold_placed') filter in SQL", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      await repository.findBySlotId("slot-123");

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/status IN \('pending',\s*'hold_placed'\)/);
    });

    it("returns undefined if not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findBySlotId("slot-123");

      expect(result).toBeUndefined();
    });

    it("does not return a cancelled intent", async () => {
      // Simulate the DB returning no rows because the partial index / status
      // filter excludes the cancelled row. The repository relies on the SQL
      // filter, not application-side filtering, so a cancelled row never
      // comes back from the query.
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findBySlotId("slot-123");

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("status IN ('pending', 'hold_placed')");
      expect(result).toBeUndefined();
    });
  });

  // ─── findBySlotIdAndCustomer: status filter ───────────────────────────────

  describe("findBySlotIdAndCustomer", () => {
    it("returns the record if found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.findBySlotIdAndCustomer("slot-123", "cust-789");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM booking_intents WHERE slot_id = $1 AND customer_id = $2"),
        ["slot-123", "cust-789"]
      );

      expect(result).toEqual(expectedRecord);
    });

    it("includes status IN ('pending','hold_placed') filter in SQL", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      await repository.findBySlotIdAndCustomer("slot-123", "cust-789");

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/status IN \('pending',\s*'hold_placed'\)/);
    });

    it("does not return a cancelled intent", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findBySlotIdAndCustomer("slot-123", "cust-789");

      const [sql] = mockQuery.mock.calls[0];
      expect(sql).toContain("status IN ('pending', 'hold_placed')");
      expect(result).toBeUndefined();
    });
  });

  // ─── updateStatus ──────────────────────────────────────────────────────────

  describe("updateStatus", () => {
    it("updates the status and returns the updated record", async () => {
      const updatedRow = { ...dbRow, status: "confirmed" };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);

      const result = await repository.updateStatus("intent-uuid", "confirmed");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringMatching(/UPDATE booking_intents\s+SET status = \$2/),
        ["intent-uuid", "confirmed"]
      );

      expect(result.status).toBe("confirmed");
    });

    it("throws NotFoundError when the intent does not exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(repository.updateStatus("unknown", "confirmed")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // ─── update ────────────────────────────────────────────────────────────────

  describe("update", () => {
    it("updates specified fields and returns the updated record", async () => {
      const updatedRow = { ...dbRow, status: "confirmed", note: "updated note" };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);

      const result = await repository.update("intent-uuid", {
        status: "confirmed",
        note: "updated note",
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/UPDATE booking_intents\s+SET/);
      expect(params).toEqual(expect.arrayContaining(["intent-uuid", "confirmed", "updated note"]));

      expect(result.status).toBe("confirmed");
      expect(result.note).toBe("updated note");
    });

    it("updates hold-related fields with correct column mapping", async () => {
      const updatedRow = {
        ...dbRow,
        booking_type: "refundable_hold",
        hold_until_ms: 300000,
      };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);

      await repository.update("intent-uuid", {
        bookingType: "refundable_hold",
        holdUntilMs: 300000,
      });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("booking_type =");
      expect(sql).toContain("hold_until_ms =");
      expect(params).toEqual(expect.arrayContaining(["intent-uuid", "refundable_hold", 300000]));
    });

    it("serialises snapshot objects to the database", async () => {
      const pricingSnapshot = {
        strategyId: "fixed" as const,
        resolvedPrice: 7500,
        basePrice: 7500,
        slotStartMs: 2000000,
        nowMs: 1000000,
        activeBookings: 2,
        capacity: 5,
        config: {},
      };
      const updatedRow = { ...dbRow, pricing_snapshot: pricingSnapshot };
      mockQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);

      await repository.update("intent-uuid", { pricingSnapshot });

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("pricing_snapshot =");
      expect(params).toEqual(expect.arrayContaining(["intent-uuid", pricingSnapshot]));
    });

    it("throws NotFoundError when the intent does not exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(
        repository.update("unknown", { status: "confirmed" }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("returns the existing record when no updatable fields are provided", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.update("intent-uuid", {});

      expect(result).toEqual(expectedRecord);
      // Only the findById query should have been issued — no UPDATE.
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][0]).toContain("SELECT * FROM booking_intents WHERE id = $1");
    });
  });

  // ─── listByCustomer ────────────────────────────────────────────────────────

  describe("listByCustomer", () => {
    it("returns all intents for a customer ordered by created_at DESC", async () => {
      const row1 = { ...dbRow, id: "intent-1" };
      const row2 = { ...dbRow, id: "intent-2", status: "confirmed" };
      mockQuery.mockResolvedValueOnce({ rows: [row1, row2], rowCount: 2 } as any);

      const result = await repository.listByCustomer("cust-789");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM booking_intents WHERE customer_id = $1"),
        ["cust-789"]
      );

      expect(mockQuery.mock.calls[0][0]).toContain("ORDER BY created_at DESC");

      expect(result).toHaveLength(2);
      expect(result[0].id).toBe("intent-1");
      expect(result[1].id).toBe("intent-2");
    });

    it("returns an empty array when no intents exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.listByCustomer("cust-789");

      expect(result).toEqual([]);
    });
  });

  // ─── listAll ───────────────────────────────────────────────────────────────

  describe("listAll", () => {
    it("returns all intents ordered by created_at DESC", async () => {
      const row1 = { ...dbRow, id: "intent-1" };
      const row2 = { ...dbRow, id: "intent-2", status: "confirmed" };
      mockQuery.mockResolvedValueOnce({ rows: [row1, row2], rowCount: 2 } as any);

      const result = await repository.listAll();

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("SELECT * FROM booking_intents");
      expect(sql).toContain("ORDER BY created_at DESC");
      expect(params).toBeUndefined();

      expect(result).toHaveLength(2);
    });

    it("returns an empty array when no intents exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.listAll();

      expect(result).toEqual([]);
    });
  });

  // ─── findExpiredHolds ───────────────────────────────────────────────────────

  describe("findExpiredHolds", () => {
    it("queries for refundable_hold intents with hold_until_ms <= nowMs", async () => {
      const expiredRow = {
        ...dbRow,
        booking_type: "refundable_hold",
        status: "hold_placed",
        hold_until_ms: 100000,
      };
      mockQuery.mockResolvedValueOnce({ rows: [expiredRow], rowCount: 1 } as any);

      const result = await repository.findExpiredHolds(200000);

      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toContain("booking_type = 'refundable_hold'");
      expect(sql).toContain("status = 'hold_placed'");
      expect(sql).toContain("hold_until_ms IS NOT NULL");
      expect(sql).toContain("hold_until_ms <= $1");
      expect(params).toEqual([200000]);

      expect(result).toHaveLength(1);
      expect(result[0].bookingType).toBe("refundable_hold");
      expect(result[0].status).toBe("hold_placed");
      expect(result[0].holdUntilMs).toBe(100000);
    });

    it("returns an empty array when no expired holds exist", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findExpiredHolds(200000);

      expect(result).toEqual([]);
    });
  });

  // ─── Round-trip mapping: snapshot and refund fields ────────────────────────

  describe("round-trip mapping preserves snapshot and refund fields", () => {
    it("preserves all snapshot, hold, and refund fields through mapRowToRecord", async () => {
      const holdPlacedAt = new Date("2026-01-01T10:00:00.000Z");
      const refundedAt = new Date("2026-01-02T12:00:00.000Z");
      const createdAt = new Date("2026-01-01T00:00:00.000Z");

      const pricingSnapshot = {
        strategyId: "time_decay" as const,
        resolvedPrice: 3000,
        basePrice: 5000,
        slotStartMs: 10000000,
        nowMs: 5000000,
        activeBookings: 3,
        capacity: 10,
        config: {},
      };

      const cancellationPolicySnapshot = {
        policyVersionId: "pol-v1",
        policyTerms: {
          tiers: [
            {
              minHoursUntilStart: 24,
              maxHoursUntilStart: 48,
              refundRatio: 1.0,
              flatFee: 0,
              percentageFee: 0,
              taxReversalRatio: 1.0,
            },
            {
              minHoursUntilStart: 0,
              maxHoursUntilStart: 24,
              refundRatio: 0.5,
              flatFee: 100,
              percentageFee: 5,
              taxReversalRatio: 0.5,
            },
          ],
          minRefundAmount: 0,
          maxRefundAmount: 10000,
        },
        capturedAtMs: 5000000,
      };

      const holdFeePolicySnapshot = {
        supplierId: "supp-123",
        holdFeeCents: 250,
        capturedAtMs: 5000000,
      };

      const refundMetadata = {
        refundedAt: "2026-01-02T12:00:00.000Z",
        refundedAmountCents: 4750,
        refundReason: "customer_cancelled",
      };

      const fullRow = {
        id: "intent-full",
        slot_id: "slot-full",
        professional_id: "prof-1",
        customer_id: "cust-1",
        start_time: new Date(1000),
        end_time: new Date(2000),
        status: "hold_refunded",
        note: null,
        token_asset: "ASSET_X",
        mint_tx_hash: "TX_HASH_X",
        created_at: createdAt,
        booking_type: "refundable_hold",
        hold_until_ms: 600000,
        hold_placed_at: holdPlacedAt,
        refunded_at: refundedAt,
        refund_metadata: refundMetadata,
        pricing_snapshot: pricingSnapshot,
        cancellation_policy_snapshot: cancellationPolicySnapshot,
        hold_fee_policy_snapshot: holdFeePolicySnapshot,
      };

      mockQuery.mockResolvedValueOnce({ rows: [fullRow], rowCount: 1 } as any);

      const result = await repository.findById("intent-full");

      expect(result).toEqual({
        id: "intent-full",
        slotId: "slot-full",
        professional: "prof-1",
        customerId: "cust-1",
        startTime: 1000,
        endTime: 2000,
        status: "hold_refunded",
        note: undefined,
        tokenAsset: "ASSET_X",
        mintTxHash: "TX_HASH_X",
        createdAt: createdAt.toISOString(),
        bookingType: "refundable_hold",
        holdUntilMs: 600000,
        holdPlacedAt: holdPlacedAt.toISOString(),
        refundedAt: refundedAt.toISOString(),
        refundMetadata: refundMetadata,
        pricingSnapshot: pricingSnapshot,
        cancellationPolicySnapshot: cancellationPolicySnapshot,
        holdFeePolicySnapshot: holdFeePolicySnapshot,
      });
    });
  });

  // ─── Interface implementation ──────────────────────────────────────────────

  describe("implements BookingIntentRepository", () => {
    it("can be assigned to a BookingIntentRepository variable", () => {
      const repo: BookingIntentRepository = repository;
      expect(repo).toBe(repository);
    });
  });
});
