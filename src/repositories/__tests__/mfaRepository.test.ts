import { jest } from "@jest/globals";
import type { MfaRepository } from "../../models/mfaEnrollment.js";
import { PgMfaRepository, getMfaRepository, setMfaRepositoryForTests } from "../mfaRepository.js";

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

function fakeQuery(
  handler: (sql: {
    text: string;
    params: unknown[];
  }) => { rows?: unknown[]; rowCount?: number | null },
) {
  return async (text: string, params?: unknown[]) => {
    const out = handler({ text, params: params ?? [] });
    return {
      rows: out.rows ?? [],
      rowCount: out.rowCount ?? out.rows?.length ?? 0,
      command: "UPDATE",
      oid: 0,
      fields: [],
    };
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

function fakeRepository(): MfaRepository {
  return {
    upsertEnrollment: jest.fn(),
    findByUserId: jest.fn(),
    markVerified: jest.fn(),
    advanceLastUsedCounter: jest.fn(),
    deleteByUserId: jest.fn(),
  } as unknown as MfaRepository;
}

describe("PgMfaRepository", () => {
  describe("upsertEnrollment", () => {
    it("inserts and returns the mapped row", async () => {
      const dbQuery = fakeQuery(({ text, params }) => {
        expect(text).toContain("INSERT INTO mfa_enrollments");
        expect(text).toContain("ON CONFLICT (user_id)");
        expect(params).toEqual(["user-123", "cipher", "iv", "tag", "salt", "SHA1", 6, 30]);
        return { rows: [makeRow()] };
      });
      const repo = new PgMfaRepository(dbQuery);
      const row = await repo.upsertEnrollment(input);
      expect(row.user_id).toBe("user-123");
      expect(row.last_used_counter).toBeNull();
    });

    it("binds parameters in the declared column order", async () => {
      const dbQuery = fakeQuery(({ text }) => {
        const placeholders = [...text.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
        expect(placeholders.slice(0, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        return { rows: [makeRow({ algorithm: "SHA256", digits: 8, period: 60 })] };
      });
      const repo = new PgMfaRepository(dbQuery);
      const row = await repo.upsertEnrollment({
        ...input,
        algorithm: "SHA256",
        digits: 8,
        period: 60,
      });
      expect(row.algorithm).toBe("SHA256");
      expect(row.digits).toBe(8);
      expect(row.period).toBe(60);
    });

    it("resets verification and counter state on re-enrollment", async () => {
      const dbQuery = fakeQuery(({ text }) => {
        expect(text).toContain("verified = FALSE");
        expect(text).toContain("last_used_counter = NULL");
        return { rows: [makeRow({ verified: false, last_used_counter: null })] };
      });
      const repo = new PgMfaRepository(dbQuery);
      const row = await repo.upsertEnrollment(input);
      expect(row.verified).toBe(false);
      expect(row.last_used_counter).toBeNull();
    });

    it("propagates constraint violations from the database", async () => {
      const failure = Object.assign(
        new Error('null value in column "secret_ciphertext" violates not-null constraint'),
        {
          code: "23502",
        },
      );
      const repo = new PgMfaRepository(async () => {
        throw failure;
      });
      await expect(
        repo.upsertEnrollment({ ...input, secretCiphertext: undefined as unknown as string }),
      ).rejects.toBe(failure);
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

    it.each(["", "   "])("passes malformed user id %j through to the query", async (userId) => {
      const dbQuery = fakeQuery(({ params }) => {
        expect(params).toEqual([userId]);
        return { rows: [] };
      });
      const repo = new PgMfaRepository(dbQuery);
      expect(await repo.findByUserId(userId)).toBeNull();
    });

    it("treats null last_used_counter as the never-used boundary", async () => {
      const repo = new PgMfaRepository(
        fakeQuery(() => ({ rows: [makeRow({ last_used_counter: null })] })),
      );
      const row = await repo.findByUserId("user-123");
      expect(row?.last_used_counter).toBeNull();
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

    it("treats a null rowCount as no rows updated", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rowCount: null })));
      expect(await repo.markVerified("user-123")).toBe(false);
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

    it("treats a null rowCount as a replay", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rows: [], rowCount: null })));
      const result = await repo.advanceLastUsedCounter("user-123", 2);
      expect(result.advanced).toBe(false);
      expect(result.enrollment).toBeNull();
    });

    it("ignores rows present while rowCount is 0", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rows: [makeRow()], rowCount: 0 })));
      const result = await repo.advanceLastUsedCounter("user-123", 1);
      expect(result.advanced).toBe(false);
      expect(result.enrollment).toBeNull();
    });

    it("passes the submitted step as the monotonic bound ($2)", async () => {
      const dbQuery = fakeQuery(({ text, params }) => {
        expect(text).toContain("last_used_counter IS NULL OR last_used_counter < $2");
        expect(params).toEqual(["user-123", 5]);
        return { rows: [makeRow({ last_used_counter: 5 })], rowCount: 1 };
      });
      const repo = new PgMfaRepository(dbQuery);
      const result = await repo.advanceLastUsedCounter("user-123", 5);
      expect(result.advanced).toBe(true);
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

    it("treats a null rowCount as nothing deleted", async () => {
      const repo = new PgMfaRepository(fakeQuery(() => ({ rowCount: null })));
      expect(await repo.deleteByUserId("user-123")).toBe(false);
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

    it("propagates DB failures to the caller", async () => {
      const failure = new Error("connection refused");
      const repo = new PgMfaRepository(async () => {
        throw failure;
      });
      await expect(repo.findByUserId("user-123")).rejects.toBe(failure);
      await expect(repo.upsertEnrollment(input)).rejects.toBe(failure);
    });
  });
});

describe("repository singleton + test seam", () => {
  afterEach(() => {
    setMfaRepositoryForTests(null);
  });

  it("getMfaRepository returns a stable singleton", () => {
    expect(getMfaRepository()).toBe(getMfaRepository());
  });

  it("getMfaRepository lazily creates a PgMfaRepository on first call", () => {
    const repo = getMfaRepository();
    expect(repo).toBeInstanceOf(PgMfaRepository);
  });

  it("setMfaRepositoryForTests replaces the singleton with the injected instance", () => {
    const fake = {
      upsertEnrollment: jest.fn(),
      findByUserId: jest.fn(),
      markVerified: jest.fn(),
      advanceLastUsedCounter: jest.fn(),
      deleteByUserId: jest.fn(),
    } as unknown as MfaRepository;
    setMfaRepositoryForTests(fake);
    expect(getMfaRepository()).toBe(fake);
  });

  it("setMfaRepositoryForTests(null) clears the override so a fresh default is created lazily", () => {
    const fake = fakeRepository();
    setMfaRepositoryForTests(fake);
    expect(getMfaRepository()).toBe(fake);

    setMfaRepositoryForTests(null);
    const restored = getMfaRepository();
    expect(restored).not.toBe(fake);
    expect(restored).toBeInstanceOf(PgMfaRepository);
    expect(getMfaRepository()).toBe(restored);
  });

  it("keeps returning the same default instance while no override is active", () => {
    const first = getMfaRepository();
    expect(getMfaRepository()).toBe(first);

    setMfaRepositoryForTests(fakeRepository());
    expect(getMfaRepository()).not.toBe(first);

    setMfaRepositoryForTests(null);
    expect(getMfaRepository()).not.toBe(first);
  });

  it("calls routed through the injected fake are visible to getMfaRepository consumers", async () => {
    const fake = fakeRepository();
    setMfaRepositoryForTests(fake);
    const repo = getMfaRepository();
    await repo.findByUserId("user-123");
    expect(fake.findByUserId).toHaveBeenCalledWith("user-123");
  });
});
