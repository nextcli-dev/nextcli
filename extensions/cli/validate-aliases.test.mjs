import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { findLocalPackages, wrongSubpathAliases } from "./validate-aliases.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const build = readFileSync(resolve(here, "build.mjs"), "utf8");
const packages = findLocalPackages(resolve(here, "package.json"));
const sqliteFile = resolve(here, "../../packages/context/dist/sqlite.js");

describe("validate-aliases: subpath exports", () => {
  it("accepts build.mjs as it is", () => {
    expect(wrongSubpathAliases(build, packages)).toEqual([]);
  });

  it("requires an alias for each subpath a local package exports", () => {
    // esbuild would send @nextcli/context/sqlite to dist/index.js/sqlite
    const without = build.replace(
      /"@nextcli\/context\/sqlite": resolve\([^)]*\),\n/,
      "",
    );
    expect(without).not.toBe(build);

    expect(wrongSubpathAliases(without, packages)).toEqual([
      { alias: "@nextcli/context/sqlite", file: sqliteFile },
    ]);
  });

  it("requires it to point at that subpath's file", () => {
    const elsewhere = build.replace(
      '"../../packages/context/dist/sqlite.js"',
      '"../../packages/context/dist/index.js"',
    );
    expect(elsewhere).not.toBe(build);

    expect(wrongSubpathAliases(elsewhere, packages)).toEqual([
      { alias: "@nextcli/context/sqlite", file: sqliteFile },
    ]);
  });
});
