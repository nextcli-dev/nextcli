// Run with: node --test scripts/ci/check-deprecations.test.mjs
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildFindings,
  collectPackages,
  evaluate,
  fetchDeprecations,
  findLockfiles,
} from "./check-deprecations.mjs";

const REG = "https://registry.npmjs.org";

// root -> eslint (dev) -> glob@7 -> inflight; root -> adf-to-md -> glob@7.
// app -> uuid@9 nested under app, hoisted uuid@11 for the root.
const lock = {
  lockfileVersion: 3,
  packages: {
    "": {
      dependencies: { "adf-to-md": "^1", uuid: "^11", app: "file:../app" },
      devDependencies: { eslint: "^8" },
    },
    "node_modules/adf-to-md": {
      version: "1.2.1",
      resolved: `${REG}/adf-to-md/-/adf-to-md-1.2.1.tgz`,
      dependencies: { glob: "^7" },
    },
    "node_modules/eslint": {
      version: "8.57.1",
      resolved: `${REG}/eslint/-/eslint-8.57.1.tgz`,
      dev: true,
      dependencies: { glob: "^7" },
    },
    "node_modules/glob": {
      version: "7.2.3",
      resolved: `${REG}/glob/-/glob-7.2.3.tgz`,
      dependencies: { inflight: "^1" },
    },
    "node_modules/inflight": {
      version: "1.0.6",
      resolved: `${REG}/inflight/-/inflight-1.0.6.tgz`,
    },
    "node_modules/uuid": {
      version: "11.1.0",
      resolved: `${REG}/uuid/-/uuid-11.1.0.tgz`,
    },
    "node_modules/app": { resolved: "../app", link: true },
    "../app": { version: "1.0.0", dependencies: { uuid: "^9" } },
    "../app/node_modules/uuid": {
      version: "9.0.1",
      resolved: `${REG}/uuid/-/uuid-9.0.1.tgz`,
    },
    "node_modules/local-shim": {
      version: "2.0.0",
      resolved: "file:../shims/local-shim",
    },
  },
};

test("collectPackages skips links and non-registry packages", () => {
  const names = collectPackages(lock).map((p) => `${p.name}@${p.version}`);
  assert.ok(!names.some((n) => n.startsWith("app@")));
  assert.ok(!names.some((n) => n.startsWith("local-shim@")));
  assert.ok(names.includes("inflight@1.0.6"));
});

test("collectPackages traces each package to the root's direct dependencies", () => {
  const byName = Object.fromEntries(
    collectPackages(lock).map((p) => [`${p.name}@${p.version}`, p]),
  );
  assert.deepEqual(byName["inflight@1.0.6"].roots, ["adf-to-md", "eslint"]);
  assert.deepEqual(byName["eslint@8.57.1"].roots, ["eslint"]);
  assert.equal(byName["eslint@8.57.1"].dev, true);
  assert.deepEqual(byName["uuid@11.1.0"].roots, ["uuid"]);
  // Reached through the `file:` link to ../app.
  assert.deepEqual(byName["uuid@9.0.1"].roots, ["app"]);
});

test("collectPackages rejects lockfiles without a packages map", () => {
  assert.throws(
    () => collectPackages({ lockfileVersion: 1, dependencies: {} }),
    /lockfileVersion 1/,
  );
});

// A fake registry: name -> versions map, or a status code.
function fakeFetch(registry) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, accept: init.headers.accept });
    const name = decodeURIComponent(url.slice(REG.length + 1));
    const entry = registry[name];
    if (typeof entry === "number") {
      return { ok: false, status: entry, json: async () => ({}) };
    }
    if (!entry) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ versions: entry }) };
  };
  return { impl, calls };
}

test("fetchDeprecations keeps only deprecated versions and dedupes names", async () => {
  const { impl, calls } = fakeFetch({
    uuid: { "9.0.1": { deprecated: "too old" }, "11.1.0": {} },
    glob: { "7.2.3": { deprecated: "old glob" } },
    eslint: { "10.0.0": {} },
  });
  const { deprecated, missing } = await fetchDeprecations(
    ["uuid", "glob", "uuid", "eslint"],
    { fetchImpl: impl, registry: REG, concurrency: 2 },
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.accept.includes("install-v1")));
  assert.deepEqual(deprecated.get("uuid"), { "9.0.1": "too old" });
  assert.deepEqual(deprecated.get("glob"), { "7.2.3": "old glob" });
  assert.equal(deprecated.has("eslint"), false);
  assert.deepEqual(missing, []);
});

test("fetchDeprecations keeps the @ of scoped names and encodes the slash", async () => {
  const { impl, calls } = fakeFetch({ "@humanwhocodes/config-array": {} });
  await fetchDeprecations(["@humanwhocodes/config-array"], {
    fetchImpl: impl,
    registry: REG,
  });
  assert.equal(calls[0].url, `${REG}/@humanwhocodes%2Fconfig-array`);
});

test("fetchDeprecations reports unknown packages and retries failures", async () => {
  let attempts = 0;
  const flaky = async (url, init) => {
    if (url.endsWith("/flaky") && ++attempts < 2) throw new Error("reset");
    return fakeFetch({ flaky: { "1.0.0": { deprecated: "x" } } }).impl(
      url,
      init,
    );
  };
  const { deprecated, missing } = await fetchDeprecations(
    ["flaky", "private-pkg"],
    { fetchImpl: flaky, registry: REG, retries: 2 },
  );
  assert.equal(attempts, 2);
  assert.deepEqual(deprecated.get("flaky"), { "1.0.0": "x" });
  assert.deepEqual(missing, ["private-pkg"]);
});

test("fetchDeprecations gives up after the retries", async () => {
  const { impl } = fakeFetch({ broken: 503 });
  await assert.rejects(
    fetchDeprecations(["broken"], {
      fetchImpl: impl,
      registry: REG,
      retries: 1,
    }),
    /Could not read registry metadata for broken/,
  );
});

test("buildFindings merges one package across lockfiles and roots", () => {
  const deprecated = new Map([
    ["glob", { "7.2.3": "old glob" }],
    ["uuid", { "9.0.1": "too old" }],
  ]);
  const findings = buildFindings(
    {
      "core/package-lock.json": [
        { name: "glob", version: "7.2.3", dev: false, roots: ["adf-to-md"] },
        { name: "glob", version: "7.2.3", dev: true, roots: ["eslint"] },
        { name: "uuid", version: "11.1.0", dev: false, roots: ["uuid"] },
      ],
      "gui/package-lock.json": [
        { name: "glob", version: "7.2.3", dev: true, roots: ["eslint"] },
        { name: "uuid", version: "9.0.1", dev: false, roots: ["uuid"] },
      ],
    },
    deprecated,
  );
  assert.deepEqual(
    findings.map((f) => `${f.name}@${f.version}`),
    ["glob@7.2.3", "uuid@9.0.1"],
  );
  assert.deepEqual(findings[0].locations, [
    {
      lockfile: "core/package-lock.json",
      dev: false,
      roots: ["adf-to-md", "eslint"],
    },
    { lockfile: "gui/package-lock.json", dev: true, roots: ["eslint"] },
  ]);
});

test("evaluate separates new findings and stale allowlist entries", () => {
  const f = (name, version) => ({ name, version, message: "", locations: [] });
  const findings = [
    f("glob", "7.2.3"),
    f("whatwg-encoding", "3.1.1"),
    f("left-pad", "1.0.0"),
  ];
  const { allowed, unexpected, stale } = evaluate(findings, [
    { name: "glob", version: "7.2.3" },
    { name: "whatwg-encoding" },
    { name: "uuid", version: "9.0.1" },
    { name: "glob", version: "8.1.0" },
  ]);
  assert.deepEqual(
    allowed.map((x) => x.name),
    ["glob", "whatwg-encoding"],
  );
  assert.deepEqual(
    unexpected.map((x) => x.name),
    ["left-pad"],
  );
  assert.deepEqual(stale, [
    { name: "uuid", version: "9.0.1" },
    { name: "glob", version: "8.1.0" },
  ]);
});

test("findLockfiles skips node_modules and build output", () => {
  const root = mkdtempSync(path.join(tmpdir(), "deprecations-"));
  for (const dir of [
    "",
    "core",
    "core/node_modules/x",
    "docs-site/.next",
    "gui/dist",
    "packages/fetch",
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, "package-lock.json"), "{}");
  }
  assert.deepEqual(findLockfiles(root), [
    "core/package-lock.json",
    "package-lock.json",
    path.join("packages", "fetch", "package-lock.json"),
  ]);
});
