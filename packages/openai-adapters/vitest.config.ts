import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    testTimeout: 10000,
    include: ["src/**/*.test.{ts,tsx}", "src/**/*.vitest.{ts,tsx}"],
    // Live tests call real APIs with your keys: run them by hand with
    // LIVE_TESTS=1 (see each file's header), never in CI
    exclude: [
      ...configDefaults.exclude,
      ...(process.env.LIVE_TESTS ? [] : ["src/**/*.live.test.{ts,tsx}"]),
    ],
  },
  resolve: {
    alias: {
      "(.+)\\.js": "$1",
    },
  },
});
