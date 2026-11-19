import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Each test drives real git processes; slow CI disks need headroom.
    testTimeout: 30_000,
  },
});
