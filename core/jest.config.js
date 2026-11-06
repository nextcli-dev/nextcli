import path from "path";
import { fileURLToPath } from "url";

import { bundleJsdomForJest } from "./test/bundleJsdomForJest.mjs";

// Bundles jsdom for Jest first (see test/bundleJsdomForJest.mjs).
export default async () => {
  await bundleJsdomForJest();
  return config;
};

const config = {
  transform: {
    "^.+\\.(ts|js)$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          // Transpile each file on its own, without typechecking the program.
          // (ts-jest's own `isolatedModules` option is deprecated in favor of
          // this one.)
          isolatedModules: true,
        },
      },
    ],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
    "^uuid$": "uuid", // https://stackoverflow.com/a/73626360
    // jsdom 29 has ESM-only dependencies that Jest can't require():
    // bundled to CommonJS by test/bundleJsdomForJest.mjs
    "^jsdom$": "<rootDir>/node_modules/.cache/jsdom-cjs/jsdom.cjs",
    "^@azure/(.*)$": "<rootDir>/node_modules/@azure/$1",
    "^mssql$": "<rootDir>/node_modules/mssql",
  },
  extensionsToTreatAsEsm: [".ts"],
  preset: "ts-jest/presets/default-esm",
  testTimeout: 10000,
  testEnvironment: "node",
  globals: {
    __dirname: path.dirname(fileURLToPath(import.meta.url)),
    __filename: path.resolve(fileURLToPath(import.meta.url)),
  },
  // collectCoverage: true,
  collectCoverageFrom: [
    "**/*.{js,ts}", // Adjust this pattern to match files you want coverage for
    "!**/node_modules/**", // Exclude node_modules
    "!**/vendor/**",
    // "!**/autocomplete/context/root-path-context/test/files/**",
  ],
  globalSetup: "<rootDir>/test/jest.global-setup.ts",
  setupFilesAfterEnv: ["<rootDir>/test/jest.setup-after-env.js"],
  maxWorkers: 1, // equivalent to CLI --runInBand
  testMatch: ["**/*.test.ts"],
};
