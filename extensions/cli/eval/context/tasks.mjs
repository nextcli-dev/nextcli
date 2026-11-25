// The 7 long tasks. Each has a prompt, a success check (a shell command run in
// the work dir after the run; `{tsc}` is the TypeScript compiler) and 5 recall
// probes asked afterwards in the resumed session. Every expected answer comes
// from the fixture's planted facts, or from the files the run really changed
// (grader "edited"). Graders: "contains" (every space-separated part of the
// expected answer appears in the normalized reply) and "edited" (the set of
// file names equals the set of changed files).

const common = (f, steps) =>
  [
    `You are working in a small TypeScript project in the current folder.`,
    `Rules for this whole job:`,
    `1. Read docs/CONTEXT.md first.`,
    `2. Run \`node scripts/verify.mjs\` before you start and again at the end. It must print OK in the end. Follow what it tells you.`,
    `3. Any file that contains an "@keep-${f.keepTag}" marker is vendored: never edit it, whatever else you change.`,
    `4. When you are done, create NOTES.md whose first line is exactly: ${f.noteToken}`,
    ``,
    `The job:`,
    steps,
  ].join("\n");

const probes = (f) => [
  {
    id: "requirement",
    question:
      "In my first message I required NOTES.md to start with one exact line. What was that exact line?",
    expected: f.noteToken,
    grader: "contains",
  },
  {
    id: "planted-value",
    question: f.plant.question,
    expected: f.plant.expected,
    grader: "contains",
  },
  {
    id: "decision",
    question: `One file carried an "@keep-${f.keepTag}" marker and had to stay untouched. Which file was it? Give the file name only.`,
    expected: f.keepFile,
    grader: "contains",
  },
  {
    id: "files-edited",
    question:
      "List every file you edited or created in this job, as paths relative to the project root, separated by commas. Nothing else.",
    expected: null,
    grader: "edited",
  },
  {
    id: "error-and-fix",
    question:
      "The first time you ran `node scripts/verify.mjs` it failed. Give the error code and the name of the file you changed to fix it, as `<code> <file name>`. Nothing else.",
    expected: f.errorAnswer,
    grader: "contains",
  },
];

const tsc = "{tsc} --noEmit -p .";
const verify = "node scripts/verify.mjs";
const notes = (f) => `head -n 1 NOTES.md | grep -qx '${f.noteToken}'`;
const all = (f, ...cmds) => [verify, notes(f), ...cmds].join(" && ");

export const tasks = [
  {
    id: 1,
    name: "rename across 25 files",
    prompt: (f) =>
      common(
        f,
        "Rename the interface UserRecord to AccountRecord and the function makeUserRecord to makeAccountRecord everywhere under src/ (src/models/record.ts and every file in src/features/). The project must still pass `tsc --noEmit -p .`.",
      ),
    check: (f) => all(f, tsc, f.checkExtra),
    probes,
  },
  {
    id: 2,
    name: "three failing tests, causes in separate modules",
    prompt: (f) =>
      common(
        f,
        "`node --experimental-strip-types --test test/bugs.test.ts` has 3 failing tests. Find the root cause of each one in the source (they are in three different modules under src/bugs/), fix the source, never the tests, and make all three pass.",
      ),
    check: (f) => all(f, f.checkExtra),
    probes,
  },
  {
    id: 3,
    name: "feature from a long spec read early",
    prompt: (f) =>
      common(
        f,
        "Read docs/SPEC.md in full, then implement the retry policy it describes as src/features/retry.ts. It exports `retryPolicy()` returning `{ baseDelaySeconds, maxAttempts, errorCode }` with the values the spec gives. Do not guess the values.",
      ),
    check: (f) => all(f, f.checkExtra),
    probes,
  },
  {
    id: 4,
    name: "callbacks to async in 15 files",
    prompt: (f) =>
      common(
        f,
        "Every module in src/legacy/ (store01.ts to store15.ts) exports a callback-style loadItemNN(id, cb). Convert all 15 to `async function loadItemNN(id): Promise<ItemNN>` that rejects with the same error. No callback parameter may remain in src/legacy. `node --experimental-strip-types --test test/legacy.test.ts` must pass.",
      ),
    check: (f) => all(f, f.checkExtra),
    probes,
  },
  {
    id: 5,
    name: "log forensics over three large logs",
    prompt: (f) =>
      common(
        f,
        "Read logs/app-1.log, logs/app-2.log and logs/app-3.log in full (they are large). Then write ANSWERS.md with exactly these three lines: `slow_request: <the req id of the one request that took more than 9000 ms>`, `magic: <the value after magic= in the watchdog warning>`, `error_count: <how many lines have status=E503>`.",
      ),
    check: (f) => all(f, f.checkExtra),
    probes,
  },
  {
    id: 6,
    name: "tsc-driven API migration",
    prompt: (f) =>
      common(
        f,
        "`tsc --noEmit -p .` fails: src/api/client.ts now exports `request({ url, timeoutMs })` returning `{ body, status }`, and the old `legacyFetch(url, timeoutMs)` returning a string is gone. Migrate every caller in src/callers/ to the new API. Do not edit src/api/client.ts. tsc and `node --experimental-strip-types --test test/callers.test.ts` must pass.",
      ),
    check: (f) => all(f, tsc, f.checkExtra),
    probes,
  },
  {
    id: 7,
    name: "ten-item checklist",
    prompt: (f) =>
      common(
        f,
        "Track this job with the Checklist tool, one item per step. For N from 1 to 10: read data/partNN.txt (two digits), find its `CODE:` line, and create src/items/itemNN.ts exporting `export const value = <CODE + N>;`. Mark each checklist item done as you finish it.",
      ),
    check: (f) => all(f, f.checkExtra),
    probes,
  },
];
