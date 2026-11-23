import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { Pool } from "pg";
import { MigrationRunner } from "../db/migrationRunner.js";
import { migrations } from "../db/migrations/index.js";
import * as migrationRepository from "../db/migrationRepository.js";

describe("slot exclusion constraint", () => {
  let pool: Pool;
  let runner: MigrationRunner;

  beforeAll(async () => {
    // Create a fresh test database connection
    pool = new Pool({
      connectionString: process.env.POSTGRESQL_URL || "postgres://test:test@localhost:5432/testdb",
    });

    runner = new MigrationRunner(pool, migrationRepository, migrations);

    // Clean up any existing schema
    await pool.query("DROP TABLE IF EXISTS slots CASCADE");
    await pool.query("DROP TABLE IF EXISTS users CASCADE");
    await pool.query("DROP TABLE IF EXISTS schema_migrations CASCADE");
    await pool.query("DROP EXTENSION IF EXISTS btree_gist CASCADE");
    await pool.query("DROP TYPE IF EXISTS slot_status CASCADE");

    // Apply migrations 001, 002, and 003
    const result = await runner.up();
    expect(result.success).toBe(true);
    expect(result.applied).toEqual(["001", "002", "003"]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("rejects overlapping slots for the same professional", async () => {
    // Create a professional
    const professionalResult = await pool.query(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      ["professional1@test.com"]
    );
    const professionalId = professionalResult.rows[0].id;

    // Insert first slot
    await pool.query(
      `INSERT INTO slots (professional_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4)`,
      [professionalId, "2026-01-01 09:00:00+00", "2026-01-01 10:00:00+00", "available"]
    );

    // Attempt to insert overlapping slot - should fail
    await expect(
      pool.query(
        `INSERT INTO slots (professional_id, start_time, end_time, status)
         VALUES ($1, $2, $3, $4)`,
        [professionalId, "2026-01-01 09:30:00+00", "2026-01-01 10:30:00+00", "available"]
      )
    ).rejects.toThrow(/exclusion constraint/);
  });

  it("allows adjacent slots for the same professional", async () => {
    // Create a professional
    const professionalResult = await pool.query(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      ["professional2@test.com"]
    );
    const professionalId = professionalResult.rows[0].id;

    // Insert first slot
    await pool.query(
      `INSERT INTO slots (professional_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4)`,
      [professionalId, "2026-01-01 14:00:00+00", "2026-01-01 15:00:00+00", "available"]
    );

    // Insert adjacent slot (end of first == start of second) - should succeed
    const result = await pool.query(
      `INSERT INTO slots (professional_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [professionalId, "2026-01-01 15:00:00+00", "2026-01-01 16:00:00+00", "available"]
    );

    expect(result.rows).toHaveLength(1);
  });

  it("allows overlapping slots for different professionals", async () => {
    // Create two professionals
    const professional1Result = await pool.query(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      ["professional3@test.com"]
    );
    const professional1Id = professional1Result.rows[0].id;

    const professional2Result = await pool.query(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      ["professional4@test.com"]
    );
    const professional2Id = professional2Result.rows[0].id;

    // Insert slot for professional1
    await pool.query(
      `INSERT INTO slots (professional_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4)`,
      [professional1Id, "2026-01-01 16:00:00+00", "2026-01-01 17:00:00+00", "available"]
    );

    // Insert overlapping slot for professional2 - should succeed
    const result = await pool.query(
      `INSERT INTO slots (professional_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [professional2Id, "2026-01-01 16:30:00+00", "2026-01-01 17:30:00+00", "available"]
    );

    expect(result.rows).toHaveLength(1);
  });

  it("rejects fully contained overlapping slots", async () => {
    // Create a professional
    const professionalResult = await pool.query(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      ["professional5@test.com"]
    );
    const professionalId = professionalResult.rows[0].id;

    // Insert first slot
    await pool.query(
      `INSERT INTO slots (professional_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4)`,
      [professionalId, "2026-01-01 18:00:00+00", "2026-01-01 20:00:00+00", "available"]
    );

    // Attempt to insert slot fully contained within first slot - should fail
    await expect(
      pool.query(
        `INSERT INTO slots (professional_id, start_time, end_time, status)
         VALUES ($1, $2, $3, $4)`,
        [professionalId, "2026-01-01 18:30:00+00", "2026-01-01 19:30:00+00", "available"]
      )
    ).rejects.toThrow(/exclusion constraint/);
  });

  it("rejects slots that fully contain existing slots", async () => {
    // Create a professional
    const professionalResult = await pool.query(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      ["professional6@test.com"]
    );
    const professionalId = professionalResult.rows[0].id;

    // Insert first slot
    await pool.query(
      `INSERT INTO slots (professional_id, start_time, end_time, status)
       VALUES ($1, $2, $3, $4)`,
      [professionalId, "2026-01-01 20:00:00+00", "2026-01-01 21:00:00+00", "available"]
    );

    // Attempt to insert slot that fully contains the first slot - should fail
    await expect(
      pool.query(
        `INSERT INTO slots (professional_id, start_time, end_time, status)
         VALUES ($1, $2, $3, $4)`,
        [professionalId, "2026-01-01 19:30:00+00", "2026-01-01 21:30:00+00", "available"]
      )
    ).rejects.toThrow(/exclusion constraint/);
  });
});
