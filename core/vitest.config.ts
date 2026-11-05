import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        // `vitest --changed` / `vitest related` resolve the bare "diff"
        // package import against the project root, where core/diff/ is a
        // source folder, and fail with "Failed to load url core/diff".
        // Point it at the package explicitly. (__dirname, not import.meta:
        // the VS Code extension's CommonJS typecheck includes this file.)
        find: /^diff$/,
        replacement: path.join(__dirname, "node_modules/diff/libesm/index.js"),
      },
    ],
  },
  test: {
    testTransformMode: {
      web: ["/.[jt]s?$/"],
      ssr: ["/.[jt]s?$/"],
    },
    globalSetup: "./test/vitest.global-setup.ts",
    setupFiles: "./test/vitest.setup.ts",
    fileParallelism: false,
    include: ["**/*.vitest.ts"],
  },
});
