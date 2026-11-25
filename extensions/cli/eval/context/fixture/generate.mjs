// Deterministic generator of the small TypeScript repo every task works on.
// `generateFixture(dir, { task, seed })` writes a visible repo and returns the
// planted facts (exact answers) plus the hidden checks, which the runner
// copies into the work dir only after the run. Nothing here calls a model.
//
//   node fixture/generate.mjs <dir> [task 1-7] [seed]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORDS =
  `alpha basalt cipher delta ember fjord garnet harbor indigo juniper
kestrel lantern meridian nectar onyx pylon quartz raven saffron tundra umber
velvet willow xenon yarrow zephyr anchor bridge copper dynamo engine falcon
glacier hollow island jigsaw kernel ledger mosaic nimbus orchard pebble quiver
ripple signal timber upland vector wander yonder zenith budget cache queue
retry token schema parser buffer router socket tenant ticket vendor module`.split(
    /\s+/,
  );

export function makeRng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (list) => list[Math.floor(next() * list.length)],
    hex: (n) =>
      Array.from({ length: n }, () =>
        Math.floor(next() * 16).toString(16),
      ).join(""),
  };
}

/** About `tokens` tokens of filler prose (4 characters each) */
function prose(rng, tokens) {
  const out = [];
  let chars = 0;
  while (chars < tokens * 4) {
    const sentence = Array.from({ length: rng.int(8, 16) }, () =>
      rng.pick(WORDS),
    ).join(" ");
    out.push(sentence.charAt(0).toUpperCase() + sentence.slice(1) + ".");
    chars += sentence.length + 2;
  }
  return out;
}

/** Filler as a block comment: it costs tokens when read and nothing else */
function comment(rng, tokens) {
  const lines = prose(rng, tokens).map((s) => ` * ${s}`);
  return `/**\n${lines.join("\n")}\n */\n`;
}

const pad = (n) => String(n).padStart(2, "0");

export function generateFixture(dir, { task = 1, seed = 1 } = {}) {
  const rng = makeRng(seed * 1000 + task);
  const files = {};
  const hidden = {};
  const facts = { task, seed };

  facts.noteToken = `RUN-${rng.hex(6).toUpperCase()}`;
  facts.keepTag = rng.pick(WORDS) + rng.int(10, 99);
  facts.ticket = `TKT-${rng.int(1000, 9999)}`;
  facts.errorCode = `E-${rng.int(1000, 9999)}`;
  facts.registryExport = `task${task}Ready`;
  facts.keepFile = `vendor_${rng.pick(WORDS)}.ts`;

  // Shared core: decoy modules, the read-first context file, the gate script
  files["package.json"] = JSON.stringify(
    { name: "eval-fixture", private: true, type: "module" },
    null,
    2,
  );
  files["tsconfig.json"] = JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: [],
      },
      include: ["src"],
    },
    null,
    2,
  );
  files["docs/CONTEXT.md"] = [
    "# Project context",
    "",
    ...prose(rng, 1200),
    "",
    `The deploy ticket for this change is ${facts.ticket}.`,
    "",
    ...prose(rng, 300),
  ].join("\n");
  for (const name of ["strings", "math", "dates", "ids", "log", "queue"]) {
    files[`src/util/${name}.ts`] =
      `${comment(rng, 600)}export function ${name}Helper(x: number): number {\n  return x + ${rng.int(1, 9)};\n}\n`;
  }
  files["src/registry.ts"] =
    `${comment(rng, 300)}export const registryVersion = ${rng.int(1, 9)};\n`;
  files["scripts/verify.mjs"] = [
    `import fs from "node:fs";`,
    `const registry = fs.readFileSync(new URL("../src/registry.ts", import.meta.url), "utf8");`,
    `if (!registry.includes("export const ${facts.registryExport} = true")) {`,
    `  console.log('verify: FAIL ${facts.errorCode}: src/registry.ts must export "${facts.registryExport}" as true');`,
    `  process.exit(1);`,
    `}`,
    `console.log("verify: OK");`,
    ``,
  ].join("\n");
  files[`src/frozen/${facts.keepFile}`] = "";
  facts.errorAnswer = `${facts.errorCode} registry.ts`;

  const layers = {
    1: layerRename,
    2: layerBugs,
    3: layerSpec,
    4: layerCallbacks,
    5: layerLogs,
    6: layerMigration,
    7: layerChecklist,
  };
  const keepBody = layers[task]({ rng, files, hidden, facts });
  files[`src/frozen/${facts.keepFile}`] =
    `// @keep-${facts.keepTag}: vendored file, never edit it.\n${keepBody ?? ""}\n`;

  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text.endsWith("\n") ? text : text + "\n");
  }
  return { facts, hidden, keepFile: `src/frozen/${facts.keepFile}` };
}

// 1: rename UserRecord to AccountRecord across 25 files
function layerRename({ rng, files, hidden, facts }) {
  files["src/models/record.ts"] =
    `${comment(rng, 1500)}export interface UserRecord {\n  id: string;\n  name: string;\n  tier: number;\n}\n\nexport function makeUserRecord(id: string, tier: number): UserRecord {\n  return { id, name: "user-" + id, tier };\n}\n`;
  for (let i = 1; i <= 24; i++) {
    files[`src/features/f${pad(i)}.ts`] =
      `import { makeUserRecord, type UserRecord } from "../models/record.ts";\n\n${comment(rng, 2200)}export function describe${pad(i)}(id: string): string {\n  const record: UserRecord = makeUserRecord(id, ${i});\n  return record.name + ":" + record.tier;\n}\n`;
  }
  facts.checkExtra = `! grep -rl "UserRecord" src | grep -v src/frozen`;
  facts.plant = {
    question:
      "What was the deploy ticket named in docs/CONTEXT.md? Give only the ticket id.",
    expected: facts.ticket,
  };
  return `// Legacy note: this vendored file mentions UserRecord only in a comment.\nexport const frozenRecordCount = ${rng.int(1, 9)};`;
}

// 2: three failing tests, each cause in its own module
function layerBugs({ rng, files, facts }) {
  const mods = {
    pricing: `export function toCents(amount: number): number {\n  return Math.floor(amount * 100);\n}\n`,
    calendar: `export function daysInMonth(year: number, month: number): number {\n  if (month === 2) {\n    return year % 4 === 0 ? 29 : 28;\n  }\n  return [4, 6, 9, 11].includes(month) ? 30 : 31;\n}\n`,
    slugs: `export function slugify(text: string): string {\n  return text.trim().toLowerCase().replace(/[^a-z0-9]+/, "-");\n}\n`,
  };
  for (const [name, body] of Object.entries(mods)) {
    files[`src/bugs/${name}.ts`] = `${comment(rng, 1800)}${body}`;
  }
  files["test/bugs.test.ts"] = [
    `import assert from "node:assert/strict";`,
    `import { test } from "node:test";`,
    `import { toCents } from "../src/bugs/pricing.ts";`,
    `import { daysInMonth } from "../src/bugs/calendar.ts";`,
    `import { slugify } from "../src/bugs/slugs.ts";`,
    `test("price in cents", () => assert.equal(toCents(19.99), 1999));`,
    `test("february in 1900", () => assert.equal(daysInMonth(1900, 2), 28));`,
    `test("slug of a title", () => assert.equal(slugify("  Hello,  World! "), "hello-world"));`,
    ``,
  ].join("\n");
  for (let i = 1; i <= 8; i++) {
    files[`src/bugs/extra${pad(i)}.ts`] =
      `${comment(rng, 1500)}export const extra${pad(i)} = ${rng.int(1, 99)};\n`;
  }
  facts.checkExtra = "node --experimental-strip-types --test test/bugs.test.ts";
  facts.plant = {
    question:
      "Which module (file name only) held the cause of the failing test named 'february in 1900'?",
    expected: "calendar.ts",
  };
  return "export const frozenBugs = 0;";
}

// 3: a feature specified by a long spec read first
function layerSpec({ rng, files, hidden, facts }) {
  facts.delay = rng.int(31, 97);
  facts.attempts = rng.int(4, 9);
  facts.retryCode = `E-RETRY-${rng.int(1000, 9999)}`;
  const sections = [];
  for (let i = 1; i <= 14; i++) {
    sections.push(
      `## ${i}. ${rng.pick(WORDS)} ${rng.pick(WORDS)} rules`,
      "",
      ...prose(rng, 650),
      "",
    );
  }
  sections.push(
    "## 15. Retry policy",
    "",
    `The retry policy waits ${facts.delay} seconds before the first retry and gives up after ${facts.attempts} attempts in total. When it gives up it reports the error code ${facts.retryCode}.`,
    "",
    ...prose(rng, 500),
  );
  files["docs/SPEC.md"] = ["# Service specification", "", ...sections].join(
    "\n",
  );
  for (let i = 1; i <= 6; i++) {
    files[`src/features/part${pad(i)}.ts`] =
      `${comment(rng, 800)}export const part${pad(i)} = ${rng.int(1, 99)};\n`;
  }
  hidden["__checks__/retry.test.ts"] = [
    `import assert from "node:assert/strict";`,
    `import { test } from "node:test";`,
    `import { retryPolicy } from "../src/features/retry.ts";`,
    `test("retry policy", () => {`,
    `  assert.deepEqual(retryPolicy(), { baseDelaySeconds: ${facts.delay}, maxAttempts: ${facts.attempts}, errorCode: "${facts.retryCode}" });`,
    `});`,
    ``,
  ].join("\n");
  facts.checkExtra =
    "node --experimental-strip-types --test __checks__/retry.test.ts";
  facts.plant = {
    question:
      "How many seconds does docs/SPEC.md say the retry policy waits before the first retry? Give only the number.",
    expected: String(facts.delay),
  };
  return "export const frozenSpec = 0;";
}

// 4: 15 callback-style modules to async
function layerCallbacks({ rng, files, facts }) {
  for (let i = 1; i <= 15; i++) {
    files[`src/legacy/store${pad(i)}.ts`] =
      `${comment(rng, 900)}export interface Item${pad(i)} {\n  id: string;\n  n: number;\n}\n\nexport function loadItem${pad(i)}(\n  id: string,\n  cb: (err: Error | null, value?: Item${pad(i)}) => void,\n): void {\n  setImmediate(() => {\n    if (id === "missing") {\n      cb(new Error("not found: ${pad(i)}"));\n    } else {\n      cb(null, { id, n: ${i} });\n    }\n  });\n}\n`;
  }
  files["test/legacy.test.ts"] = [
    `import assert from "node:assert/strict";`,
    `import { test } from "node:test";`,
    `test("every store resolves and rejects", async () => {`,
    `  for (let i = 1; i <= 15; i++) {`,
    `    const mod = await import("../src/legacy/store" + String(i).padStart(2, "0") + ".ts");`,
    `    const load = mod["loadItem" + String(i).padStart(2, "0")];`,
    `    assert.deepEqual(await load("a"), { id: "a", n: i });`,
    `    await assert.rejects(() => load("missing"), /not found/);`,
    `  }`,
    `});`,
    ``,
  ].join("\n");
  facts.checkExtra = `node --experimental-strip-types --test test/legacy.test.ts && ! grep -rE "cb:|callback" src/legacy`;
  facts.plant = {
    question:
      "What was the deploy ticket named in docs/CONTEXT.md? Give only the ticket id.",
    expected: facts.ticket,
  };
  return "export function frozenLoad(cb: () => void): void {\n  cb();\n}";
}

// 5: forensics over three ~20K-token logs
function layerLogs({ rng, files, hidden, facts }) {
  facts.slowRequest = `r-${rng.hex(8)}`;
  facts.magic = rng.hex(12);
  facts.errorCount = rng.int(23, 61);
  const lines = (file, extra) => {
    const rows = [];
    let t = Date.UTC(2026, 2, 1) + file * 86400000;
    for (let i = 0; rows.join("\n").length < 76000; i++) {
      t += rng.int(100, 900);
      const code = rng.pick(["E200", "E201", "E404", "E429", "E500"]);
      rows.push(
        `${new Date(t).toISOString()} INFO req=r-${rng.hex(8)} route=/${rng.pick(WORDS)}/${rng.pick(WORDS)} status=${code} ms=${rng.int(5, 1800)} node=${rng.pick(WORDS)}`,
      );
    }
    for (const [at, row] of extra) rows.splice(at, 0, row);
    return rows.join("\n");
  };
  files["logs/app-1.log"] = lines(1, [
    [
      rng.int(100, 500),
      `2026-03-02T04:11:09.000Z WARN req=${facts.slowRequest} route=/export/all status=E200 ms=${rng.int(9001, 9900)} node=slow`,
    ],
  ]);
  files["logs/app-2.log"] = lines(2, [
    [
      rng.int(100, 500),
      `2026-03-03T09:00:00.000Z WARN watchdog: magic=${facts.magic} restart scheduled`,
    ],
  ]);
  const errors = Array.from({ length: facts.errorCount }, (_, i) => [
    80 + i * 9,
    `2026-03-04T12:00:${pad(i % 60)}.000Z ERROR req=r-${rng.hex(8)} route=/pay/charge status=E503 ms=${rng.int(5, 900)} node=pay`,
  ]);
  files["logs/app-3.log"] = lines(3, errors);
  facts.plant = {
    question:
      "What magic value did the watchdog warning in the logs print? Give only the value.",
    expected: facts.magic,
  };
  hidden["__checks__/answers.sh"] =
    [
      `grep -qx "slow_request: ${facts.slowRequest}" ANSWERS.md`,
      `grep -qx "magic: ${facts.magic}" ANSWERS.md`,
      `grep -qx "error_count: ${facts.errorCount}" ANSWERS.md`,
    ].join(" && ") + "\n";
  facts.checkExtra = "sh __checks__/answers.sh";
  return "// Vendored log format notes.\nexport const frozenLogs = 0;";
}

// 6: tsc-driven migration from legacyFetch(url, ms) to request({ url, timeoutMs })
function layerMigration({ rng, files, facts }) {
  files["src/api/client.ts"] =
    `${comment(rng, 1200)}export interface RequestOptions {\n  url: string;\n  timeoutMs: number;\n}\n\nexport interface Response2 {\n  body: string;\n  status: number;\n}\n\nexport async function request(options: RequestOptions): Promise<Response2> {\n  return { body: "ok-" + options.url, status: 200 };\n}\n`;
  for (let i = 1; i <= 12; i++) {
    files[`src/callers/c${pad(i)}.ts`] =
      `import { legacyFetch } from "../api/client.ts";\n\n${comment(rng, 1800)}export async function call${pad(i)}(): Promise<string> {\n  const text = await legacyFetch("/c${pad(i)}", ${rng.int(100, 900)});\n  return text.toUpperCase();\n}\n`;
  }
  files["test/callers.test.ts"] = [
    `import assert from "node:assert/strict";`,
    `import { test } from "node:test";`,
    `test("callers use the new client", async () => {`,
    `  for (let i = 1; i <= 12; i++) {`,
    `    const id = String(i).padStart(2, "0");`,
    `    const mod = await import("../src/callers/c" + id + ".ts");`,
    `    assert.equal(await mod["call" + id](), "OK-/C" + id);`,
    `  }`,
    `});`,
    ``,
  ].join("\n");
  facts.checkExtra =
    "node --experimental-strip-types --test test/callers.test.ts && ! grep -rl legacyFetch src | grep -v src/frozen";
  facts.plant = {
    question:
      "What was the deploy ticket named in docs/CONTEXT.md? Give only the ticket id.",
    expected: facts.ticket,
  };
  return "// legacyFetch is gone; this vendored file only mentions it in a comment.\nexport const frozenApi = 0;";
}

// 7: ten items, each from its own long data file
function layerChecklist({ rng, files, hidden, facts }) {
  const codes = [];
  for (let i = 1; i <= 10; i++) {
    const code = rng.int(1000, 99999);
    codes.push(code);
    const body = prose(rng, 5000);
    body.splice(rng.int(5, body.length - 5), 0, `CODE: ${code}`);
    files[`data/part${pad(i)}.txt`] = body.join("\n");
  }
  hidden["__checks__/items.test.ts"] = [
    `import assert from "node:assert/strict";`,
    `import { test } from "node:test";`,
    `const expected = ${JSON.stringify(codes.map((c, i) => c + i + 1))};`,
    `test("ten items", async () => {`,
    `  for (let i = 1; i <= 10; i++) {`,
    `    const mod = await import("../src/items/item" + String(i).padStart(2, "0") + ".ts");`,
    `    assert.equal(mod.value, expected[i - 1]);`,
    `  }`,
    `});`,
    ``,
  ].join("\n");
  facts.checkExtra =
    "node --experimental-strip-types --test __checks__/items.test.ts";
  facts.plant = {
    question:
      "What was the CODE line in data/part07.txt? Give only the number.",
    expected: String(codes[6]),
  };
  return "export const frozenItems = 0;";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, task, seed] = process.argv.slice(2);
  if (!dir) {
    console.error("usage: node fixture/generate.mjs <dir> [task 1-7] [seed]");
    process.exit(2);
  }
  const { facts } = generateFixture(dir, {
    task: Number(task ?? 1),
    seed: Number(seed ?? 1),
  });
  console.log(JSON.stringify(facts, null, 2));
}
