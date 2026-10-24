import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Pool } from "pg";
import { MigrationRunner } from "../../db/migrationRunner.js";
import * as migrationRepository from "../../db/migrationRepository.js";
import { migration as migration021 } from "../../db/migrations/021_create_mfa_enrollments_table.js";

const migrations = [migration021];

describe("Migration 021: create_mfa_enrollments_table", () => {
  let pool: Pool;
  let runner: MigrationRunner;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.POSTGRESQL_URL || "postgres://test:test@localhost:5432/testdb",
    });

    runner = new MigrationRunner(pool, migrationRepository, migrations);

    await pool.query("DROP TABLE IF EXISTS mfa_enrollments CASCADE");
    await pool.query("DROP TABLE IF EXISTS schema_migrations CASCADE");

    const result = await runner.up();
    expect(result.success).toBe(true);
    expect(result.applied).toContain("021");
  });

  afterAll(async () => {
    await pool.end();
  });

  describe("up migration", () => {
    it("creates the mfa_enrollments table", async () => {
      const result = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'mfa_enrollments'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].table_name).toBe("mfa_enrollments");
    });

    it("has the expected columns with correct types", async () => {
      const result = await pool.query(`
        SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_name = 'mfa_enrollments'
        ORDER BY ordinal_position
      `);

      const columns = result.rows.reduce((acc, row) => {
        acc[row.column_name] = {
          data_type: row.data_type,
          is_nullable: row.is_nullable,
          column_default: row.column_default,
        };
        return acc;
      }, {} as Record<string, { data_type: string; is_nullable: string; column_default: string | null }>);

      expect(columns.user_id).toEqual({
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      });

      expect(columns.secret_ciphertext).toEqual({
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      });

      expect(columns.secret_iv).toEqual({
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      });

      expect(columns.secret_auth_tag).toEqual({
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      });

      expect(columns.kdf_salt).toEqual({
        data_type: "text",
        is_nullable: "NO",
        column_default: null,
      });

      expect(columns.algorithm).toEqual({
        data_type: "character varying",
        is_nullable: "NO",
        column_default: "'SHA1'::character varying",
      });

      expect(columns.digits).toEqual({
        data_type: "smallint",
        is_nullable: "NO",
        column_default: "6",
      });

      expect(columns.period).toEqual({
        data_type: "integer",
        is_nullable: "NO",
        column_default: "30",
      });

      expect(columns.verified).toEqual({
        data_type: "boolean",
        is_nullable: "NO",
        column_default: "false",
      });

      expect(columns.last_used_counter).toEqual({
        data_type: "bigint",
        is_nullable: "YES",
        column_default: null,
      });

      expect(columns.created_at).toMatchObject({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });

      expect(columns.updated_at).toMatchObject({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });
    });

    it("has user_id as primary key", async () => {
      const result = await pool.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_name = 'mfa_enrollments'
          AND tc.constraint_type = 'PRIMARY KEY'
      `);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].column_name).toBe("user_id");
    });

    it("has check constraint on digits (6-10)", async () => {
      const result = await pool.query(`
        SELECT conname, pg_get_constraintdef(oid) as definition
        FROM pg_constraint
        WHERE conrelid = 'mfa_enrollments'::regclass
          AND contype = 'c'
      `);
      const checkConstraints = result.rows.map(r => r.definition);
      expect(checkConstraints.some(d => d.includes("digits BETWEEN 6 AND 10"))).toBe(true);
    });

    it("has check constraint on period (> 0)", async () => {
      const result = await pool.query(`
        SELECT conname, pg_get_constraintdef(oid) as definition
        FROM pg_constraint
        WHERE conrelid = 'mfa_enrollments'::regclass
          AND contype = 'c'
      `);
      const checkConstraints = result.rows.map(r => r.definition);
      expect(checkConstraints.some(d => d.includes("period > 0"))).toBe(true);
    });

    it("has check constraint on last_used_counter (>= 0)", async () => {
      const result = await pool.query(`
        SELECT conname, pg_get_constraintdef(oid) as definition
        FROM pg_constraint
        WHERE conrelid = 'mfa_enrollments'::regclass
          AND contype = 'c'
      `);
      const checkConstraints = result.rows.map(r => r.definition);
      expect(checkConstraints.some(d => d.includes("last_used_counter IS NULL OR last_used_counter >= 0"))).toBe(true);
    });

    it("has index on verified column", async () => {
      const result = await pool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'mfa_enrollments'
      `);
      const indexes = result.rows.map(r => r.indexname);
      expect(indexes).toContain("mfa_enrollments_verified_idx");
    });

    it("accepts a valid enrollment with all required fields", async () => {
      await pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt
        ) VALUES ($1, $2, $3, $4, $5)
      `, ["user-valid-1", "cipher", "iv", "tag", "salt"]);

      const result = await pool.query(`SELECT * FROM mfa_enrollments WHERE user_id = $1`, ["user-valid-1"]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0].algorithm).toBe("SHA1");
      expect(result.rows[0].digits).toBe(6);
      expect(result.rows[0].period).toBe(30);
      expect(result.rows[0].verified).toBe(false);
      expect(result.rows[0].last_used_counter).toBeNull();
      expect(result.rows[0].created_at).toBeDefined();
      expect(result.rows[0].updated_at).toBeDefined();
    });

    it("accepts a valid enrollment with custom algorithm/digits/period", async () => {
      await pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt,
          algorithm, digits, period
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, ["user-valid-2", "cipher", "iv", "tag", "salt", "SHA256", 8, 60]);

      const result = await pool.query(`SELECT * FROM mfa_enrollments WHERE user_id = $1`, ["user-valid-2"]);
      expect(result.rows[0].algorithm).toBe("SHA256");
      expect(result.rows[0].digits).toBe(8);
      expect(result.rows[0].period).toBe(60);
    });

    it("rejects insert missing required field secret_ciphertext", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_iv, secret_auth_tag, kdf_salt
        ) VALUES ($1, $2, $3, $4)
      `, ["user-invalid-1", "iv", "tag", "salt"])).rejects.toThrow(/null value in column "secret_ciphertext"/);
    });

    it("rejects insert missing required field secret_iv", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_auth_tag, kdf_salt
        ) VALUES ($1, $2, $3, $4)
      `, ["user-invalid-2", "cipher", "tag", "salt"])).rejects.toThrow(/null value in column "secret_iv"/);
    });

    it("rejects insert missing required field secret_auth_tag", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, kdf_salt
        ) VALUES ($1, $2, $3, $4)
      `, ["user-invalid-3", "cipher", "iv", "salt"])).rejects.toThrow(/null value in column "secret_auth_tag"/);
    });

    it("rejects insert missing required field kdf_salt", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag
        ) VALUES ($1, $2, $3, $4)
      `, ["user-invalid-4", "cipher", "iv", "tag"])).rejects.toThrow(/null value in column "kdf_salt"/);
    });

    it("rejects duplicate user_id (primary key violation)", async () => {
      await pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt
        ) VALUES ($1, $2, $3, $4, $5)
      `, ["user-duplicate", "cipher1", "iv1", "tag1", "salt1"]);

      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt
        ) VALUES ($1, $2, $3, $4, $5)
      `, ["user-duplicate", "cipher2", "iv2", "tag2", "salt2"])).rejects.toThrow(/duplicate key value violates unique constraint/);
    });

    it("rejects digits < 6", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt, digits
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, ["user-digits-low", "cipher", "iv", "tag", "salt", 5])).rejects.toThrow(/check constraint/);
    });

    it("rejects digits > 10", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt, digits
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, ["user-digits-high", "cipher", "iv", "tag", "salt", 11])).rejects.toThrow(/check constraint/);
    });

    it("rejects period <= 0", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt, period
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, ["user-period-zero", "cipher", "iv", "tag", "salt", 0])).rejects.toThrow(/check constraint/);
    });

    it("rejects negative period", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt, period
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, ["user-period-neg", "cipher", "iv", "tag", "salt", -1])).rejects.toThrow(/check constraint/);
    });

    it("rejects negative last_used_counter", async () => {
      await expect(pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt, last_used_counter
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, ["user-counter-neg", "cipher", "iv", "tag", "salt", -1])).rejects.toThrow(/check constraint/);
    });

    it("accepts null last_used_counter", async () => {
      await pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt, last_used_counter
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, ["user-counter-null", "cipher", "iv", "tag", "salt", null]);

      const result = await pool.query(`SELECT last_used_counter FROM mfa_enrollments WHERE user_id = $1`, ["user-counter-null"]);
      expect(result.rows[0].last_used_counter).toBeNull();
    });

    it("accepts valid positive last_used_counter", async () => {
      await pool.query(`
        INSERT INTO mfa_enrollments (
          user_id, secret_ciphertext, secret_iv, secret_auth_tag, kdf_salt, last_used_counter
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, ["user-counter-valid", "cipher", "iv", "tag", "salt", 42]);

      const result = await pool.query(`SELECT last_used_counter FROM mfa_enrollments WHERE user_id = $1`, ["user-counter-valid"]);
      expect(result.rows[0].last_used_counter).toBe("42");
    });

    it("has table comment", async () => {
      const result = await pool.query(`
        SELECT obj_description('mfa_enrollments'::regclass) as comment
      `);
      expect(result.rows[0].comment).toContain("Per-user TOTP MFA enrollments");
      expect(result.rows[0].comment).toContain("AES-256-GCM");
      expect(result.rows[0].comment).toContain("HKDF");
    });
  });

  describe("down migration (rollback)", () => {
    it("drops the index and table cleanly", async () => {
      const result = await runner.down(1);
      expect(result.success).toBe(true);
      expect(result.applied).toContain("021");

      const tableResult = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'mfa_enrollments'
      `);
      expect(tableResult.rows).toHaveLength(0);

      const indexResult = await pool.query(`
        SELECT indexname
        FROM pg_indexes
        WHERE indexname = 'mfa_enrollments_verified_idx'
      `);
      expect(indexResult.rows).toHaveLength(0);
    });

    it("can be re-applied after rollback", async () => {
      const result = await runner.up();
      expect(result.success).toBe(true);
      expect(result.applied).toContain("021");

      const tableResult = await pool.query(`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_name = 'mfa_enrollments'
      `);
      expect(tableResult.rows).toHaveLength(1);
    });
  });
});