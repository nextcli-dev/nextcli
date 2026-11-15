import { defineConfig } from "eslint/config";
import noBarrelFiles from "eslint-plugin-no-barrel-files";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["dist/**"] },
  {
    // TypeScript only: gui/tsconfig.json has allowJs: false, so a JS file
    // would fail type-aware linting ("not found in any of the projects").
    files: ["**/*.{ts,tsx}"],
    linterOptions: { reportUnusedDisableDirectives: "off" },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
      "no-barrel-files": noBarrelFiles,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: ["tsconfig.json", "tsconfig.node.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/naming-convention": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "no-barrel-files/no-barrel-files": "error",
    },
  },
]);
