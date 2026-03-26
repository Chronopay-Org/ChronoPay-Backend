// Provide a safe dummy POSTGRESQL_URL for all test suites so that
// pool.ts does not throw at module-load time in environments where
// a real .env file is not present (e.g. CI).
process.env.POSTGRESQL_URL =
  process.env.POSTGRESQL_URL ?? "postgres://test:test@localhost:5432/testdb";
