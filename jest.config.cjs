/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^(\\.{1,2}/.*)$": "$1",
    "^ioredis$": "<rootDir>/src/mocks/ioredis.ts",
    "^prom-client$": "<rootDir>/src/mocks/prom-client.ts",
  },
  transform: { "^.+\\.tsx?$": ["ts-jest", { useESM: true }] },
  testMatch: ["**/__tests__/**/*.test.ts"],
  clearMocks: true,
};
