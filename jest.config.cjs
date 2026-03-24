/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "node",
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: { "^(\\.{1,2}/.*)\\.js$": "$1" },
  transform: { 
    "^.+\\.tsx?$": [
      "ts-jest",
      { 
        useESM: true,
        isolatedModules: true,
        tsconfig: {
          isolatedModules: true,
        },
      },
    ],
  },
  testMatch: ["**/__tests__/**/*.test.ts"],
};
