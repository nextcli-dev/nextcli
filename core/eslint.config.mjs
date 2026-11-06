import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

import {
  sharedIgnores,
  sharedLinterOptions,
  sharedRules,
} from "../eslint.shared.mjs";

export default defineConfig([
  { ignores: sharedIgnores },
  {
    files: ["**/*.ts"],
    linterOptions: sharedLinterOptions,
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      quotes: ["off", "double", {}],
      "@typescript-eslint/naming-convention": "off",
      // This is important: when floating promises cause unhandled rejections, the core process blows up
      "@typescript-eslint/no-floating-promises": "error",
      curly: "off",
      eqeqeq: "error",
      complexity: ["error", { max: 36 }],
      "max-lines-per-function": ["error", { max: 500 }],
      "max-statements": ["error", { max: 108 }],
      "max-depth": ["error", { max: 6 }],
      "max-nested-callbacks": ["error", { max: 4 }],
      "max-params": ["error", { max: 8 }],
    },
  },
  {
    files: [
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.vitest.ts",
    ],
    rules: { "max-lines-per-function": "off" },
  },
]);
