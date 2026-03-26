/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: { "^.+\\.tsx?$": ["ts-jest", { useESM: true, diagnostics: { ignoreCodes: [151002] } }] },
  testMatch: ["**/__tests__/**/*.test.ts"],
  setupFiles: ["./jest.setup.ts"],
};
