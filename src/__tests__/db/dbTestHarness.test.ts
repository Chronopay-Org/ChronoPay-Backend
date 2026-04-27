import { jest } from "@jest/globals";
import { getPool, closePool, _setPoolFactory } from "../../db/connection.js";
import {
  setupCleanDb,
  runMigrations,
  teardownDb,
  verifyTableExists,
  verifyColumnExists,
} from "../utils/dbTestHarness.js";
import { MigrationRunner } from "../../db/migrationRunner.js";

// We will mock the Pool class
class MockPool {
  query = jest.fn();
  connect = jest.fn().mockResolvedValue({
    query: jest.fn(),
    release: jest.fn(),
  });
  on = jest.fn();
  end = jest.fn();
}

describe("DB Test Harness", () => {
  let originalEnv: NodeJS.ProcessEnv;
  let poolMock: MockPool;

  beforeAll(() => {
    // Inject mock pool factory
    _setPoolFactory((connString) => {
      poolMock = new MockPool() as any;
      return poolMock as any;
    });
  });

  beforeEach(async () => {
    originalEnv = { ...process.env };
    // Ensure getPool() creates our mock pool
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/test_db";
    process.env.NODE_ENV = "test";
    
    // Close existing pool to force re-initialization
    await closePool();
    
    // Initialize the pool
    getPool();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    process.env = originalEnv;
    await closePool();
  });

  describe("Security Assertions", () => {
    it("should throw if NODE_ENV is not test", async () => {
      process.env.NODE_ENV = "production";

      await expect(setupCleanDb()).rejects.toThrow(
        /Security Error: DB Test Harness cannot run in NODE_ENV=production/
      );
    });

    it("should throw if DATABASE_URL is missing", async () => {
      process.env.NODE_ENV = "test";
      delete process.env.DATABASE_URL;

      await expect(setupCleanDb()).rejects.toThrow(
        /Security Error: DATABASE_URL is not set/
      );
    });

    it("should throw if DATABASE_URL does not contain 'test'", async () => {
      process.env.NODE_ENV = "test";
      process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/production_db";

      await expect(setupCleanDb()).rejects.toThrow(
        /Security Error: DATABASE_URL does not appear to be a test database/
      );
    });
  });

  describe("Lifecycle Methods", () => {
    it("should drop and recreate public schema on setupCleanDb", async () => {
      poolMock.query.mockResolvedValueOnce({ rows: [] } as any);
      await setupCleanDb();
      expect(poolMock.query).toHaveBeenCalledWith("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    });

    it("should drop and recreate public schema on teardownDb", async () => {
      poolMock.query.mockResolvedValueOnce({ rows: [] } as any);
      await teardownDb();
      expect(poolMock.query).toHaveBeenCalledWith("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    });

    it("should run migrations successfully", async () => {
      // Mock the MigrationRunner up method for this test by spying on it
      const spy = jest.spyOn(MigrationRunner.prototype, 'up').mockResolvedValueOnce({ success: true, applied: ['001'] });
      
      await runMigrations();
      
      expect(spy).toHaveBeenCalled();
      spy.mockRestore();
    });

    it("should throw error if migrations fail", async () => {
      const spy = jest.spyOn(MigrationRunner.prototype, 'up').mockResolvedValueOnce({
        success: false,
        failed: "001_test",
        error: new Error("Syntax error"),
        applied: []
      });

      await expect(runMigrations()).rejects.toThrow(/Migration Failed: 001_test - Syntax error/);
      spy.mockRestore();
    });
  });

  describe("Verification Methods", () => {
    it("should verify table existence", async () => {
      poolMock.query.mockResolvedValueOnce({ rows: [{ exists: true }] } as any);
      const exists = await verifyTableExists("users");
      expect(exists).toBe(true);
      expect(poolMock.query).toHaveBeenCalledWith(
        expect.stringContaining("information_schema.tables"),
        ["users"]
      );
    });

    it("should verify column existence", async () => {
      poolMock.query.mockResolvedValueOnce({ rows: [{ exists: false }] } as any);
      const exists = await verifyColumnExists("users", "email");
      expect(exists).toBe(false);
      expect(poolMock.query).toHaveBeenCalledWith(
        expect.stringContaining("information_schema.columns"),
        ["users", "email"]
      );
    });
  });
});
