import { jest } from "@jest/globals";

// Define mocks first
const mockQuery = jest.fn() as any;
const mockOn = jest.fn() as any;
const mockEnd = jest.fn() as any;

jest.unstable_mockModule("pg", () => {
  return {
    Pool: jest.fn().mockImplementation(() => {
      return {
        query: mockQuery,
        on: mockOn,
        end: mockEnd,
      };
    }),
  };
});

describe("Database Pool Configuration", () => {
  let originalEnv: string | undefined;

  beforeAll(() => {
    originalEnv = process.env.POSTGRESQL_URL;
  });

  afterAll(() => {
    process.env.POSTGRESQL_URL = originalEnv;
  });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.POSTGRESQL_URL = "postgres://test:test@localhost:5432/testdb";
  });

  it("should fail fast if POSTGRESQL_URL is missing", async () => {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);

    try {
      // Execute the module in a fresh Node process with POSTGRESQL_URL removed
      await execAsync(`node -e "import('./dist/db/pool.js')"`, {
        env: { ...process.env, POSTGRESQL_URL: "" },
      });
      throw new Error("Should have exited with error");
    } catch (error: any) {
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("FATAL: POSTGRESQL_URL environment variable is missing.");
    }
  });

  it("should initialize the pool exactly once with connectionTimeoutMillis", async () => {
    const pg = await import("pg");
    const { default: pool } = await import("../db/pool.js");

    expect(pg.Pool).toHaveBeenCalledTimes(1);
    expect(pg.Pool).toHaveBeenCalledWith({
      connectionString: process.env.POSTGRESQL_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    
    // Test the 'error' handler attachment
    expect(mockOn).toHaveBeenCalledWith("error", expect.any(Function));
    expect(pool).toBeDefined();
  });

  it("initDB() should log success on connection", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });

    const { initDB } = await import("../db/pool.js");
    await initDB();

    expect(mockQuery).toHaveBeenCalledWith("SELECT 1 AS connected");
    expect(mockConsoleLog).toHaveBeenCalledWith("Successfully initialized PostgreSQL connection pool.");

    mockConsoleLog.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("initDB() should throw error instead of exiting on failure", async () => {
    mockQuery.mockRejectedValueOnce(new Error("Connection completely failed"));

    const { initDB } = await import("../db/pool.js");
    await expect(initDB()).rejects.toThrow("Database connection failed: Connection completely failed");
  });

  it("query() wrapper should execute and log success", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {});
    mockQuery.mockResolvedValueOnce({ rowCount: 5, rows: [] });

    const { query } = await import("../db/pool.js");
    const result = await query("SELECT * FROM users WHERE id = $1", [1]);

    expect(mockQuery).toHaveBeenCalledWith("SELECT * FROM users WHERE id = $1", [1]);
    expect(result.rowCount).toBe(5);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringMatching(/Executed query in \d+ms/),
      expect.objectContaining({ text: "SELECT * FROM users WHERE id = $1", rows: 5 })
    );

    mockConsoleLog.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("query() wrapper should safely catch and throw errors", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    const mockConsoleError = jest.spyOn(console, "error").mockImplementation(() => {});
    mockQuery.mockRejectedValueOnce(new Error("Syntax error"));

    const { query } = await import("../db/pool.js");
    
    await expect(query("INVALID SQL")).rejects.toThrow("Syntax error");

    expect(mockConsoleError).toHaveBeenCalledWith(
      "Database query failed",
      expect.objectContaining({
        text: "INVALID SQL",
        message: "Syntax error"
      })
    );

    mockConsoleError.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("graceful shutdown should end pool", async () => {
    mockEnd.mockResolvedValueOnce(undefined);

    const { closePool } = await import("../db/pool.js");
    await closePool();

    expect(mockEnd).toHaveBeenCalled();
  });
});
