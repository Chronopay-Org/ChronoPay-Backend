import { jest } from "@jest/globals";
import { PgBookingIntentRepository } from "../pg-booking-intent-repository.js";
import { ConflictError } from "../../../errors/AppError.js";
import { QueryResult } from "pg";

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
          null,
          false,
          null,
        ]
      );

      expect(result).toEqual(expectedRecord);
    });

    it("persists anomaly scoring fields when provided", async () => {
      const signals = {
        velocity: 1,
        fingerprintRisk: 0.25,
        geoHopDistance: 0,
        buyerAge: 1,
      };
      const intentData = {
        slotId: "slot-123",
        professional: "prof-456",
        customerId: "cust-789",
        startTime: 1000,
        endTime: 2000,
        status: "pending" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        anomalyScore: 0.55,
        anomalyFlagged: false,
        anomalySignals: signals,
      };

      mockQuery.mockResolvedValueOnce({
        rows: [{ ...dbRow, anomaly_score: 0.55, anomaly_flagged: false, anomaly_signals: signals }],
        rowCount: 1,
      } as any);

      const result = await repository.create(intentData);

      const args = mockQuery.mock.calls[0][1] as any[];
      expect(args.slice(8)).toEqual([0.55, false, JSON.stringify(signals)]);
      expect(result.anomalyScore).toBe(0.55);
      expect(result.anomalyFlagged).toBe(false);
      expect(result.anomalySignals).toEqual(signals);
    });

    it("parses anomaly signals returned as JSON strings", async () => {
      const signals = { velocity: 0, fingerprintRisk: 0, geoHopDistance: 1, buyerAge: 0 };
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            ...dbRow,
            anomaly_score: 0.3,
            anomaly_flagged: true,
            anomaly_signals: JSON.stringify(signals),
          },
        ],
        rowCount: 1,
      } as any);

      const result = await repository.findById("intent-uuid");

      expect(result?.anomalyScore).toBe(0.3);
      expect(result?.anomalyFlagged).toBe(true);
      expect(result?.anomalySignals).toEqual(signals);
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

    it("returns undefined if not found", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.findBySlotId("slot-123");

      expect(result).toBeUndefined();
    });
  });

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
  });

  describe("listByCustomer", () => {
    it("returns all intents for the customer ordered by creation time", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [dbRow], rowCount: 1 } as any);

      const result = await repository.listByCustomer("cust-789");

      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining("SELECT * FROM booking_intents WHERE customer_id = $1"),
        ["cust-789"]
      );
      expect(result).toEqual([expectedRecord]);
    });

    it("returns an empty array when the customer has no intents", async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await repository.listByCustomer("cust-nobody");

      expect(result).toEqual([]);
    });
  });
});
