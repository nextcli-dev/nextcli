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
  {
    ignores: [
      ...sharedIgnores,
      // e2e output, downloads and per-run copies, not sources
      "e2e/_output/**",
      "e2e/storage/**",
      "e2e/artifacts/**",
      "e2e/vsix/**",
      "e2e/fixture-workspace/**",
      ".test-extensions/**",
      "e2e/.test-extensions/**",
    ],
  },
  {
    files: ["**/*.ts"],
    // The e2e tests have their own tsconfig; see the block below
    ignores: ["e2e/**"],
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
  {
    // The Selenium e2e tests (vscode-extension-tester). These rules are
    // errors because each one has hidden a real failure in this suite.
    files: ["e2e/**/*.ts"],
    linterOptions: sharedLinterOptions,
    plugins: { "@typescript-eslint": tseslint.plugin, import: importPlugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.e2e.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      "import/order": sharedImportOrder,
      // An un-awaited WebDriver call races the next step
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      // mocha's global hooks take no screenshot when they fail
      "no-restricted-globals": [
        "error",
        ...["before", "beforeEach", "after", "afterEach"].map((name) => ({
          name,
          message:
            "Import it from vscode-extension-tester, whose hooks take a screenshot when they fail.",
        })),
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.property.name='executeCommand']",
          message:
            "Use GlobalActions.runCommand: ExTester's executeCommand presses Enter on whatever pick is highlighted when none matches.",
        },
        {
          selector: "MemberExpression[optional=true][property.name='click']",
          message:
            "?.click() skips the click when the element is missing. Wait for the element (TestUtils.waitForSuccess) and click it.",
        },
      ],
    },
  },
]);
