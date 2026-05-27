// Set environment variables before any module loading
if (!process.env.REDIS_URL) {
  process.env.REDIS_URL = "redis://localhost:6379";
}
if (!process.env.POSTGRESQL_URL) {
  process.env.POSTGRESQL_URL = "postgres://test:test@localhost:5432/testdb";
}
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^(\\.{1,2}/.*)$": "$1",
  },
  transform: { "^.+\\.tsx?$": ["ts-jest", { useESM: true }] },
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
};
