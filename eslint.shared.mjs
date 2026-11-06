// Rule data shared by the per-package flat configs (core, gui, extensions/vscode).
// It holds plain data only and imports nothing, because each package installs its
// own ESLint plugins and has no access to the root node_modules.
// Translated from the former .eslintrc.shared.json.

// `out` and `dist` at any depth, as the old eslintrc's unanchored patterns did.
// `--ext ts` used to limit linting to TypeScript; flat config lints JS by default.
export const sharedIgnores = [
  "**/out/**",
  "**/dist/**",
  "**/*.d.ts",
  "**/*.{js,cjs,mjs}",
];

// ESLint 8 never reported unused disable comments; ESLint 9+ warns by default.
// Kept off so this migration doesn't change lint output; clean up separately.
export const sharedLinterOptions = { reportUnusedDisableDirectives: "off" };

export const sharedRules = {
  "no-negated-condition": "warn",
  "@typescript-eslint/naming-convention": "off",
  "@typescript-eslint/no-floating-promises": "warn",
  "@typescript-eslint/no-misused-promises": "error",
  curly: "warn",
  eqeqeq: "warn",
  "no-throw-literal": "warn",
};

// `import/order` runs through eslint-plugin-import-x, registered as `import`
// so existing `import/...` rule names and disable comments keep working.
export const sharedImportOrder = [
  "warn",
  {
    groups: [
      "builtin",
      "external",
      "internal",
      "parent",
      "sibling",
      "index",
      "object",
      "type",
    ],
    alphabetize: { order: "asc", caseInsensitive: true },
    "newlines-between": "always",
  },
];
