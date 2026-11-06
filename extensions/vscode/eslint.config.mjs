import { defineConfig } from "eslint/config";
import importPlugin from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

import {
  sharedIgnores,
  sharedImportOrder,
  sharedLinterOptions,
  sharedRules,
} from "../../eslint.shared.mjs";

export default defineConfig([
  { ignores: [...sharedIgnores, "e2e/**"] },
  {
    files: ["**/*.ts"],
    linterOptions: sharedLinterOptions,
    plugins: { "@typescript-eslint": tseslint.plugin, import: importPlugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      "import/order": sharedImportOrder,
      "@typescript-eslint/naming-convention": "off",
      // typescript-eslint 8 skips VS Code's Thenable by default; v5 checked it.
      "@typescript-eslint/no-floating-promises": [
        "warn",
        { checkThenables: true },
      ],
      "@typescript-eslint/no-misused-promises": "warn",
    },
  },
]);
