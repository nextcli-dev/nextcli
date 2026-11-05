#!/usr/bin/env node
// Lists the deprecated npm packages pinned in the repo's lockfiles, and which
// direct dependency of each package pulls them in. Used by
// .github/workflows/ci.yml; run it locally with
// `node scripts/ci/check-deprecations.mjs`.
//
// It reads every package-lock.json instead of parsing `npm ci` output, because
// CI restores node_modules from cache and then never prints the warnings. The
// deprecation notices come from the registry's abbreviated metadata, which is
// the same source npm uses for its "npm warn deprecated" lines.
//
// Known deprecations live in deprecations-allowlist.json, each with the plan
// phase that removes it. With --strict the script fails when a lockfile has a
// deprecated package that is not on the allowlist, or when an allowlist entry
// no longer matches anything (so the list only ever shrinks).

import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const ALLOWLIST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "deprecations-allowlist.json",
);

// Directories that never hold a lockfile we ship or build from.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "out",
  "build",
  "coverage",
]);

/** Every package-lock.json under rootDir, as paths relative to rootDir. */
export function findLockfiles(rootDir = ROOT) {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name === "package-lock.json") {
        found.push(path.relative(rootDir, path.join(dir, entry.name)));
      }
    }
  };
  walk(rootDir);
  return found.sort();
}

const nameFromKey = (key) => key.slice(key.lastIndexOf("node_modules/") + 13);

/**
 * The registry packages pinned in one lockfile (lockfileVersion 2 or 3), each
 * with the direct dependencies of the root package that lead to it.
 */
export function collectPackages(lock) {
  const pkgs = lock.packages;
  if (!pkgs) {
    throw new Error(
      `lockfileVersion ${lock.lockfileVersion} has no "packages" map; regenerate it with npm 7 or newer`,
    );
  }

  // Node's resolution: look in the package's own node_modules, then walk up.
  const resolve = (from, dep) => {
    let dir = from;
    for (;;) {
      const candidate = (dir ? `${dir}/` : "") + `node_modules/${dep}`;
      if (pkgs[candidate]) return candidate;
      if (!dir) return null;
      const i = dir.lastIndexOf("/node_modules/");
      dir = i < 0 ? "" : dir.slice(0, i);
    }
  };

  const dependents = new Map();
  const addEdge = (target, parent) => {
    if (!dependents.has(target)) dependents.set(target, new Set());
    dependents.get(target).add(parent);
  };
  for (const [key, meta] of Object.entries(pkgs)) {
    // A `file:` dependency is a link entry pointing at the package's own key
    // (for example "../packages/fetch"), which lists its dependencies.
    if (meta.link && pkgs[meta.resolved]) addEdge(meta.resolved, key);
    const deps = {
      ...meta.dependencies,
      ...meta.optionalDependencies,
      ...meta.peerDependencies,
      ...(key === "" ? meta.devDependencies : {}),
    };
    for (const dep of Object.keys(deps)) {
      const target = resolve(key, dep);
      if (target) addEdge(target, key);
    }
  }

  const rootsOf = (key) => {
    const roots = new Set();
    const seen = new Set([key]);
    const queue = [key];
    while (queue.length) {
      const current = queue.shift();
      for (const parent of dependents.get(current) ?? []) {
        if (parent === "") roots.add(nameFromKey(current));
        else if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return [...roots].sort();
  };

  const result = [];
  for (const [key, meta] of Object.entries(pkgs)) {
    // Keys without node_modules/ are local packages, not installed ones.
    if (!key.includes("node_modules/") || meta.link || !meta.version) continue;
    // Packages installed from a path or git aren't in the registry.
    if (meta.resolved && !/^https?:/.test(meta.resolved)) continue;
    result.push({
      name: meta.name ?? nameFromKey(key),
      version: meta.version,
      dev: Boolean(meta.dev),
      roots: rootsOf(key),
    });
  }
  return result;
}

const packumentUrl = (registry, name) =>
  `${registry.replace(/\/$/, "")}/${encodeURIComponent(name).replace(/^%40/, "@")}`;

/**
 * Looks up deprecation notices for the given package names. Returns a Map of
 * name -> { [version]: message } for deprecated versions only, plus the names
 * the registry did not know.
 */
export async function fetchDeprecations(
  names,
  {
    fetchImpl = fetch,
    registry = process.env.npm_config_registry || "https://registry.npmjs.org",
    concurrency = 16,
    retries = 2,
  } = {},
) {
  const deprecated = new Map();
  const missing = [];
  const queue = [...new Set(names)];

  const lookup = async (name) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetchImpl(packumentUrl(registry, name), {
          headers: { accept: "application/vnd.npm.install-v1+json" },
        });
        if (res.status === 404) {
          missing.push(name);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const notices = {};
        for (const [version, meta] of Object.entries(body.versions ?? {})) {
          if (meta.deprecated) notices[version] = meta.deprecated;
        }
        if (Object.keys(notices).length) deprecated.set(name, notices);
        return;
      } catch (err) {
        if (attempt >= retries) {
          throw new Error(`Could not read registry metadata for ${name}`, {
            cause: err,
          });
        }
      }
    }
  };

  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) await lookup(queue.shift());
  });
  await Promise.all(workers);
  return { deprecated, missing: missing.sort() };
}

/**
 * Joins the packages of every lockfile with the registry's notices. One
 * finding per deprecated name@version, listing each lockfile it appears in.
 */
export function buildFindings(packagesByLockfile, deprecated) {
  const findings = new Map();
  for (const [lockfile, packages] of Object.entries(packagesByLockfile)) {
    for (const pkg of packages) {
      const message = deprecated.get(pkg.name)?.[pkg.version];
      if (!message) continue;
      const id = `${pkg.name}@${pkg.version}`;
      if (!findings.has(id)) {
        findings.set(id, {
          name: pkg.name,
          version: pkg.version,
          message,
          locations: [],
        });
      }
      const locations = findings.get(id).locations;
      const existing = locations.find((l) => l.lockfile === lockfile);
      if (existing) {
        existing.roots = [...new Set([...existing.roots, ...pkg.roots])].sort();
        existing.dev = existing.dev && pkg.dev;
      } else {
        locations.push({ lockfile, dev: pkg.dev, roots: pkg.roots });
      }
    }
  }
  return [...findings.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  );
}

/**
 * Splits findings into allowed and unexpected, and reports allowlist entries
 * that match nothing. An entry without a version allows every version.
 */
export function evaluate(findings, allowlist) {
  const matches = (entry, f) =>
    entry.name === f.name && (!entry.version || entry.version === f.version);
  const allowed = [];
  const unexpected = [];
  for (const f of findings) {
    (allowlist.some((e) => matches(e, f)) ? allowed : unexpected).push(f);
  }
  const stale = allowlist.filter((e) => !findings.some((f) => matches(e, f)));
  return { allowed, unexpected, stale };
}

function formatFinding(f, entry) {
  const lines = [`  ${f.name}@${f.version}`];
  if (entry?.fix) lines.push(`    planned fix: ${entry.fix}`);
  lines.push(`    notice: ${f.message}`);
  for (const l of f.locations) {
    const via = l.roots.length ? l.roots.join(", ") : "(no path from root)";
    lines.push(`    ${l.lockfile}${l.dev ? " (dev)" : ""} <- ${via}`);
  }
  return lines.join("\n");
}

function formatSummary({ allowed, unexpected, stale }, missing) {
  const rows = [
    "## Deprecated npm packages",
    "",
    `${unexpected.length} new, ${allowed.length} known, ${stale.length} stale allowlist entries.`,
    "",
  ];
  const table = (title, list) => {
    if (!list.length) return;
    rows.push(`### ${title}`, "", "| Package | Lockfiles |", "|---|---|");
    for (const f of list) {
      const where = f.locations.map((l) => l.lockfile).join("<br>");
      rows.push(`| \`${f.name}@${f.version}\` | ${where} |`);
    }
    rows.push("");
  };
  table("New (not on the allowlist)", unexpected);
  table("Known", allowed);
  if (stale.length) {
    rows.push("### Stale allowlist entries", "");
    for (const e of stale) rows.push(`- \`${e.name}@${e.version ?? "*"}\``);
    rows.push("");
  }
  if (missing.length) {
    rows.push(`Not in the registry: ${missing.join(", ")}`, "");
  }
  return rows.join("\n");
}

function parseArgs(argv) {
  const opts = { strict: false, json: false, root: ROOT };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--strict") opts.strict = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--root") opts.root = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")).entries;

  const packagesByLockfile = {};
  for (const lockfile of findLockfiles(opts.root)) {
    const lock = JSON.parse(
      readFileSync(path.join(opts.root, lockfile), "utf8"),
    );
    packagesByLockfile[lockfile] = collectPackages(lock);
  }
  const names = Object.values(packagesByLockfile).flatMap((list) =>
    list.map((p) => p.name),
  );
  const { deprecated, missing } = await fetchDeprecations(names);
  const findings = buildFindings(packagesByLockfile, deprecated);
  const result = evaluate(findings, allowlist);

  if (opts.json) {
    console.log(JSON.stringify({ ...result, missing }, null, 2));
  } else {
    const entryFor = (f) =>
      allowlist.find(
        (e) => e.name === f.name && (!e.version || e.version === f.version),
      );
    const lockCount = Object.keys(packagesByLockfile).length;
    console.log(
      `Checked ${new Set(names).size} packages in ${lockCount} lockfiles.\n`,
    );
    if (result.unexpected.length) {
      console.log("New deprecated packages (not on the allowlist):");
      console.log(result.unexpected.map((f) => formatFinding(f)).join("\n"));
      console.log("");
    }
    if (result.allowed.length) {
      console.log("Known deprecated packages (on the allowlist):");
      console.log(
        result.allowed.map((f) => formatFinding(f, entryFor(f))).join("\n"),
      );
      console.log("");
    }
    if (result.stale.length) {
      console.log(
        "Allowlist entries that match nothing (remove them from scripts/ci/deprecations-allowlist.json):",
      );
      for (const e of result.stale) {
        console.log(`  ${e.name}@${e.version ?? "*"}`);
      }
      console.log("");
    }
    if (missing.length) {
      console.log(`Not in the registry: ${missing.join(", ")}\n`);
    }
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      formatSummary(result, missing) + "\n",
    );
  }

  const failed = result.unexpected.length > 0 || result.stale.length > 0;
  if (failed && opts.strict) process.exitCode = 1;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 2;
  });
}
