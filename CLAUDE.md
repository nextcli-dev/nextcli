# CLAUDE.md

## Before you finish: run the CI checks locally

After a change and before reporting it done or committing, run the checks CI runs (`.github/workflows/pr-checks.yaml`, `cli-pr-checks.yml`) for every area you touched. Report failures verbatim; don't call work done while one fails.

Always, from the repo root (CI's `prettier-check` job):

```bash
npx prettier --write <changed files>
git ls-files -z -- '*.js' '*.jsx' '*.ts' '*.tsx' '*.json' '*.css' '*.md' \
  | xargs -0 npx prettier --check --ignore-path .gitignore --ignore-path .prettierignore
```

CI runs `npx prettier --check "**/*.{js,jsx,ts,tsx,json,css,md}" --ignore-path .gitignore --ignore-path .prettierignore` on a clean checkout. Locally that glob also hits untracked and generated files (for example `config-yaml-schema.json`), so check tracked files as above.

Per area touched:

| Area                 | Commands                                                         |
| -------------------- | ---------------------------------------------------------------- |
| `core/`              | `npx tsc --noEmit && npm run lint && npm test && npm run vitest` |
| `gui/`               | `npx tsc --noEmit && npm run lint && npm test`                   |
| `extensions/vscode/` | `npx tsc --noEmit && npm run lint && npm run vitest`             |
| `extensions/cli/`    | `npm run lint` (tsc + eslint) `&& npm test`                      |
| `packages/<name>/`   | `npm test` (plus `npx tsc --noEmit`)                             |
| `binary/`            | `npx tsc --noEmit`                                               |

Build order matters: the CLI typechecks against `core/dist`, and `packages/*` are consumed through their `dist`. After changing `core/` or a package the CLI uses, run `npm run build` there first, or the CLI checks will test stale code.

For a narrow change, run the affected test files first, then the area's full commands above before finishing.
