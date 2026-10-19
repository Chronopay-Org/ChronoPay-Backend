/**
 * Focused contract tests for `src/models/mfaEnrollment.ts`.
 *
 * The module is intentionally types-only: it declares the runtime contracts
 * (`MfaEnrollmentRow`, `NewMfaEnrollment`, `CounterAdvanceResult`, `MfaRepository`)
 * but owns no functions of its own. Coverage therefore pins two things:
 *
 *  1. The shape contract of every exported type — field names, casing, generated
 *     columns and the camelCase -> snake_case persistence mapping. The fixtures
 *     below are annotated with the exported types, so a renamed/removed field
 *     fails `tsc`/ts-jest at compile time instead of silently drifting.
 *  2. The documented behaviour contract of `MfaRepository`, exercised through the
 *     shared in-memory implementation the service/route suites already rely on
 *     (`src/test-helpers/fakeMfaRepository.ts`). That helper is real, typed code
 *     with its own replay/upsert semantics, so this closes a genuine gap rather
 *     than testing a throwaway double.
 *
 * Representative invalid inputs are covered with `@ts-expect-error` negative
 * assertions: ts-jest type-checks this file, so an unused directive (i.e. the
 * contract no longer rejects the input) fails the run.
 */
import type {
  CounterAdvanceResult,
  MfaEnrollmentRow,
  MfaRepository,
  NewMfaEnrollment,
} from "../mfaEnrollment.js";
import { createFakeMfaRepository } from "../../test-helpers/fakeMfaRepository.js";

/** Mirrors the snake_case column naming used by the `mfa_enrollments` table. */
const camelToSnake = (key: string): string =>
  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);

/** Columns the database generates rather than accepting from `NewMfaEnrollment`. */
const GENERATED_ROW_COLUMNS = [
  "verified",
  "last_used_counter",
  "created_at",
  "updated_at",
] as const;

/** Fully-populated persisted row. Typed so a field rename breaks compilation. */
const fullRow = {
  user_id: "user-1",
  secret_ciphertext: "cipher-hex",
  secret_iv: "iv-hex",
  secret_auth_tag: "tag-hex",
  kdf_salt: "salt-hex",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
  verified: true,
  last_used_counter: 42,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
} satisfies MfaEnrollmentRow;

/** Fully-populated enrollment input. Typed so a field rename breaks compilation. */
const fullNewEnrollment = {
  userId: "user-1",
  secretCiphertext: "cipher-hex",
  secretIv: "iv-hex",
  secretAuthTag: "tag-hex",
  kdfSalt: "salt-hex",
  algorithm: "SHA1",
  digits: 6,
  period: 30,
} satisfies NewMfaEnrollment;

/** The camelCase input fields, explicitly projected onto their snake_case columns. */
const persistentColumnsOf = (
  input: NewMfaEnrollment,
): Omit<
  MfaEnrollmentRow,
  "verified" | "last_used_counter" | "created_at" | "updated_at"
> => ({
  user_id: input.userId,
  secret_ciphertext: input.secretCiphertext,
  secret_iv: input.secretIv,
  secret_auth_tag: input.secretAuthTag,
  kdf_salt: input.kdfSalt,
  algorithm: input.algorithm,
  digits: input.digits,
  period: input.period,
});

/** Narrows a CounterAdvanceResult into an observable, discriminated label. */
const decideAdvance = (result: CounterAdvanceResult): string => {
  if (result.advanced) {
    return result.enrollment
      ? `advanced@${result.enrollment.last_used_counter}`
      : "advanced-without-enrollment";
  }
  return result.enrollment ? "stale-with-row" : "replay";
};

describe("mfaEnrollment model contract", () => {
  describe("MfaEnrollmentRow", () => {
    it("uses exactly the persisted snake_case columns (snake_case of the input plus generated)", () => {
      const expectedColumns = [
        ...Object.keys(fullNewEnrollment).map(camelToSnake),
        ...GENERATED_ROW_COLUMNS,
      ].sort();

      expect(Object.keys(fullRow).sort()).toEqual(expectedColumns);
    });

    it("never leaks camelCase persistence fields", () => {
      const columns = Object.keys(fullRow);
      expect(columns.every((column) => column === column.toLowerCase())).toBe(true);
      expect(columns.some((column) => column.includes("_"))).toBe(true);
    });

    it("models the pending (unverified, null counter) boundary state", () => {
      const pending: MfaEnrollmentRow = {
        ...fullRow,
        verified: false,
        last_used_counter: null,
      };

      expect(pending.verified).toBe(false);
      expect(pending.last_used_counter).toBeNull();
      // Timestamps are ISO strings at the model boundary, not Date objects.
      expect(typeof pending.created_at).toBe("string");
      expect(typeof pending.updated_at).toBe("string");
    });
  });

  describe("NewMfaEnrollment", () => {
    it("exposes the camelCase input fields", () => {
      expect(Object.keys(fullNewEnrollment)).toEqual([
        "userId",
        "secretCiphertext",
        "secretIv",
        "secretAuthTag",
        "kdfSalt",
        "algorithm",
        "digits",
        "period",
      ]);
    });

    it("maps every field to its snake_case column with values preserved", () => {
      expect(persistentColumnsOf(fullNewEnrollment)).toEqual({
        user_id: "user-1",
        secret_ciphertext: "cipher-hex",
        secret_iv: "iv-hex",
        secret_auth_tag: "tag-hex",
        kdf_salt: "salt-hex",
        algorithm: "SHA1",
        digits: 6,
        period: 30,
      });

      for (const column of Object.keys(persistentColumnsOf(fullNewEnrollment))) {
        expect(fullRow).toHaveProperty(column);
      }
    });
  });

  describe("CounterAdvanceResult", () => {
    it("discriminates advanced (enrollment present) from replay (enrollment null)", () => {
      const advanced: CounterAdvanceResult = { advanced: true, enrollment: fullRow };
      const replay: CounterAdvanceResult = { advanced: false, enrollment: null };

      expect(decideAdvance(advanced)).toBe("advanced@42");
      expect(decideAdvance(replay)).toBe("replay");
    });

    it("keeps a null counter distinguishable from an advanced counter", () => {
      const firstUse: CounterAdvanceResult = {
        advanced: true,
        enrollment: { ...fullRow, last_used_counter: null },
      };

      expect(firstUse.advanced).toBe(true);
      expect(firstUse.enrollment?.last_used_counter).toBeNull();
    });
  });

  describe("MfaRepository contract (shared typed fake)", () => {
    it("is satisfied by the shared in-memory implementation at compile time", () => {
      const handle = createFakeMfaRepository();
      const typed: MfaRepository = handle.repo;
      const alsoTyped = handle.repo satisfies MfaRepository;

      expect(typed).toBe(handle.repo);
      expect(alsoTyped).toBe(handle.repo);
    });

    it("runs the upsert -> find -> markVerified -> advance -> delete transitions", async () => {
      const { repo, rows } = createFakeMfaRepository();

      const created = await repo.upsertEnrollment(fullNewEnrollment);
      expect(created.verified).toBe(false);
      expect(created.last_used_counter).toBeNull();
      expect(created.user_id).toBe("user-1");

      expect((await repo.findByUserId("user-1"))?.secret_ciphertext).toBe("cipher-hex");
      expect(await repo.findByUserId("missing")).toBeNull();

      expect(await repo.markVerified("user-1")).toBe(true);
      expect(await repo.markVerified("missing")).toBe(false);
      expect(rows.get("user-1")?.verified).toBe(true);

      const advance = await repo.advanceLastUsedCounter("user-1", 1);
      expect(decideAdvance(advance)).toBe("advanced@1");

      // Replaying the same step (or an older one) is rejected as stale.
      expect(await repo.advanceLastUsedCounter("user-1", 1)).toEqual({
        advanced: false,
        enrollment: null,
      });
      expect(await repo.advanceLastUsedCounter("user-1", 0)).toEqual({
        advanced: false,
        enrollment: null,
      });
      expect(decideAdvance(await repo.advanceLastUsedCounter("user-1", 2))).toBe(
        "advanced@2",
      );

      // Unknown users are a replay, never an advanced result.
      expect(await repo.advanceLastUsedCounter("missing", 1)).toEqual({
        advanced: false,
        enrollment: null,
      });

      expect(await repo.deleteByUserId("user-1")).toBe(true);
      expect(await repo.deleteByUserId("user-1")).toBe(false);
      expect(await repo.findByUserId("user-1")).toBeNull();
    });

    it("replaces a verified enrollment back to pending without duplicating the user", async () => {
      const { repo, rows } = createFakeMfaRepository();

      await repo.upsertEnrollment(fullNewEnrollment);
      await repo.markVerified("user-1");
      await repo.advanceLastUsedCounter("user-1", 9);
      expect(rows.get("user-1")?.verified).toBe(true);
      expect(rows.get("user-1")?.last_used_counter).toBe(9);

      const replaced = await repo.upsertEnrollment({
        ...fullNewEnrollment,
        secretCiphertext: "rotated-cipher-hex",
      });

      expect(replaced.secret_ciphertext).toBe("rotated-cipher-hex");
      expect(replaced.verified).toBe(false);
      expect(replaced.last_used_counter).toBeNull();
      expect(rows.size).toBe(1);
    });

    it("advances from a null counter and then requires a strictly greater step", async () => {
      const { repo } = createFakeMfaRepository();
      await repo.upsertEnrollment(fullNewEnrollment);

      expect(decideAdvance(await repo.advanceLastUsedCounter("user-1", 5))).toBe("advanced@5");
      expect((await repo.advanceLastUsedCounter("user-1", 5)).advanced).toBe(false);
      expect((await repo.advanceLastUsedCounter("user-1", 4)).advanced).toBe(false);
      expect(decideAdvance(await repo.advanceLastUsedCounter("user-1", 6))).toBe("advanced@6");
    });
  });

  describe("representative invalid inputs (type-level)", () => {
    it("rejects a row that carries a camelCase field", () => {
      const wrong: MfaEnrollmentRow = {
        // @ts-expect-error userId is not a persisted column on MfaEnrollmentRow
        userId: "user-1",
        ...fullRow,
      };

      expect("userId" in wrong).toBe(true);
    });

    it("rejects an incomplete NewMfaEnrollment", () => {
      // @ts-expect-error secretIv/secretAuthTag/kdfSalt/algorithm/digits/period are required
      const incomplete: NewMfaEnrollment = {
        userId: "user-1",
        secretCiphertext: "cipher-hex",
      };

      expect(incomplete.userId).toBe("user-1");
    });

    it("rejects a CounterAdvanceResult that omits the enrollment field", () => {
      // @ts-expect-error enrollment must be present (MfaEnrollmentRow | null)
      const missingEnrollment: CounterAdvanceResult = { advanced: true };

      expect(missingEnrollment.advanced).toBe(true);
    });
  });
});
