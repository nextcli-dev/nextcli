import { defineConfig } from "eslint/config";
import noBarrelFiles from "eslint-plugin-no-barrel-files";
import tseslint from "typescript-eslint";

export default defineConfig([
  { ignores: ["dist/**"] },
  {
    files: ["**/*.{js,ts,jsx,tsx}"],
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
      "@typescript-eslint/no-floating-promises": "warn",
      // Warn until the remaining 11 barrel files are removed (follow-up PR);
      // the old lint script checked no files, so these were never reported.
      "no-barrel-files/no-barrel-files": "warn",
    },
  },
]);
