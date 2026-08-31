import { PgMfaRepository, getMfaRepository } from "../mfaRepository.js";

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    user_id: "user-123",
    secret_ciphertext: "deadbeef",
    secret_iv: "cafe1234",
    secret_auth_tag: "b00b00",
    kdf_salt: "salted",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    verified: false,
    last_used_counter: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fakeQuery(handler: (sql: { text: string; params: unknown[] }) => { rows?: unknown[]; rowCount?: number }) {
  return async (text: string, params?: unknown[]) => {
    const out = handler({ text, params: params ?? [] });
    return { rows: out.rows ?? [], rowCount: out.rowCount ?? out.rows?.length ?? 0, command: "UPDATE", oid: 0, fields: [] };
  };
}

const input = {
  userId: "user-123",
  secretCiphertext: "cipher",
  secretIv: "iv",
  secretAuthTag: "tag",
  kdfSalt: "salt",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
};

describe("PgMfaRepository", () => {
  describe("upsertEnrollment", () => {
    it("inserts and returns the mapped row", async () => {
      const dbQuery = fakeQuery(({ text, params }) => {
        expect(text).toContain("INSERT INTO mfa_enrollments");
        expect(text).toContain("ON CONFLICT (user_id)");
        expect(params).toEqual([
          "user-123", "cipher", "iv", "tag", "salt", "SHA1", 6, 30,
        ]);
        return { rows: [makeRow()] };
      });
      const repo = new PgMfaRepository(dbQuery);
      const row = await repo.upsertEnrollment(input);
      expect(row.user_id).toBe("user-123");
      expect(row.last_used_counter).toBeNull();
    });
  });

  describe("findByUserId", () => {
    it("returns the row when present", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rows: [makeRow({ verified: true })] })));
      const row = await repo.findByUserId("user-123");
      expect(row?.verified).toBe(true);
      expect(row?.digits).toBe(6);
    });

    it("returns null when absent", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rows: [] })));
      expect(await repo.findByUserId("nobody")).toBeNull();
    });

    it("coerces last_used_counter precision to number", async () => {
      const repo = new PgMfaRepository(
        fakeQuery(() => ({ rows: [makeRow({ last_used_counter: "42" })] })),
      );
      const row = await repo.findByUserId("user-123");
      expect(row?.last_used_counter).toBe(42);
    });

    it("fills defaults when the DB row lacks algorithm/digits/period", async () => {
      const repo = new PgMfaRepository(
        fakeQuery(() => ({ rows: [makeRow({ algorithm: null, digits: null, period: null })] })),
      );
      const row = await repo.findByUserId("user-123");
      expect(row?.algorithm).toBe("SHA1");
      expect(row?.digits).toBe(6);
      expect(row?.period).toBe(30);
    });
  });

  describe("markVerified", () => {
    it("returns true when a row was updated", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rowCount: 1 })));
      expect(await repo.markVerified("user-123")).toBe(true);
    });

    it("returns false when no row matched", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rowCount: 0 })));
      expect(await repo.markVerified("nobody")).toBe(false);
    });
  });

  describe("advanceLastUsedCounter", () => {
    it("advances when the stored counter is behind", async () => {
      const dbQuery = fakeQuery(({ text, params }) => {
        expect(text).toContain("last_used_counter < $2");
        expect(params).toEqual(["user-123", 77]);
        return { rows: [makeRow({ last_used_counter: 77 })], rowCount: 1 };
      });
      const repo = new PgMfaRepository(dbQuery);
      const result = await repo.advanceLastUsedCounter("user-123", 77);
      expect(result.advanced).toBe(true);
      expect(result.enrollment?.last_used_counter).toBe(77);
    });

    it("reports replay when the stored counter is not behind", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rows: [], rowCount: 0 })));
      const result = await repo.advanceLastUsedCounter("user-123", 2);
      expect(result.advanced).toBe(false);
      expect(result.enrollment).toBeNull();
    });
  });

  describe("deleteByUserId", () => {
    it("returns true when a row was deleted", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rowCount: 1 })));
      expect(await repo.deleteByUserId("user-123")).toBe(true);
    });

    it("returns false when nothing was deleted", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rowCount: 0 })));
      expect(await repo.deleteByUserId("nobody")).toBe(false);
    });
  });

  describe("default wiring (shared pg pool)", () => {
    it("routes queries through the injected dbQuery by default", async () => {
      const repo = new PgMfaRepository();
      expect(await repo.findByUserId("nobody")).toBeNull();
      expect(await repo.markVerified("nobody")).toBe(false);
      expect(await repo.deleteByUserId("nobody")).toBe(false);
      expect((await repo.advanceLastUsedCounter("nobody", 1)).advanced).toBe(false);
    });

    it("getMfaRepository returns a stable singleton", () => {
      expect(getMfaRepository()).toBe(getMfaRepository());
    });
  });
});