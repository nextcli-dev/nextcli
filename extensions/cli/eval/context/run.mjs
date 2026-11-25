#!/usr/bin/env node
// Hand-run context eval: runs long agent tasks through `cn -p`, then asks
// recall probes in the resumed session. It spends the API key in --config
// (unless --mock). See README.md.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateFixture } from "./fixture/generate.mjs";
import {
  answerOf,
  gradeProbe,
  parseSummaryLine,
  summarizeTrace,
} from "./metrics.mjs";
import { startMockServer } from "./mock-server.mjs";
import { exec, killAll } from "./proc.mjs";
import { writeReport } from "./report.mjs";
import { tasks } from "./tasks.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(here, "../..");

const USAGE = `usage: node eval/context/run.mjs --config <cn config.yaml> --model <name> [options]
  --windows 64000,128000   context windows to test (contextLength)
  --reps 3                 repetitions per task and window
  --tasks 1,2,...          task numbers (default all 7)
  --max-cost <usd>         cap for each cn call, passed to cn --max-cost (default 5)
  --max-total-cost <usd>   stop starting runs once the runs so far cost this much
  --cn <path>              dist/cn.js to test (default this repo's extensions/cli/dist/cn.js)
  --env KEY=VALUE          extra env for cn, repeatable (e.g. NEXTCLI_COMPACTION=checkpoint)
  --label <text>           name of this variant in the report (default: the --env values)
  --out <dir>              results folder (default eval/context/results/<time>)
  --secrets <path>         .env holding the config's secrets (default <global dir>/.env)
  --trace basic|full       trace level (default full: needed for the re-read metric)
  --seed <n>               fixture seed (default 1)
  --timeout-min <n>        kill a cn call after n minutes (default 40)
  --keep-work              keep each run's project folder
  --mock                   use a local fake model instead of --config (pipeline smoke test)
  --dry-run                print the plan and check the fixtures; call nothing`;

function parseArgs(argv) {
  const opts = {
    windows: [64000, 128000],
    reps: 3,
    tasks: tasks.map((t) => t.id),
    maxCost: 5,
    env: {},
    trace: "full",
    seed: 1,
    timeoutMin: 40,
  };
  const flags = new Set(["--keep-work", "--mock", "--dry-run"]);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--help" || key === "-h") {
      console.log(USAGE);
      process.exit(0);
    }
    if (flags.has(key)) {
      opts[key.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined) fail(`${key} needs a value`);
    const nums = (v) => v.split(",").map((n) => Number(n.trim()));
    switch (key) {
      case "--config":
        opts.config = value;
        break;
      case "--model":
        opts.model = value;
        break;
      case "--windows":
        opts.windows = nums(value);
        break;
      case "--reps":
        opts.reps = Number(value);
        break;
      case "--tasks":
        opts.tasks = nums(value);
        break;
      case "--max-cost":
        opts.maxCost = Number(value);
        break;
      case "--max-total-cost":
        opts.maxTotalCost = Number(value);
        break;
      case "--cn":
        opts.cn = value;
        break;
      case "--label":
        opts.label = value;
        break;
      case "--out":
        opts.out = value;
        break;
      case "--secrets":
        opts.secrets = value;
        break;
      case "--trace":
        opts.trace = value;
        break;
      case "--seed":
        opts.seed = Number(value);
        break;
      case "--timeout-min":
        opts.timeoutMin = Number(value);
        break;
      case "--env": {
        const eq = value.indexOf("=");
        if (eq < 1) fail(`--env needs KEY=VALUE, got "${value}"`);
        opts.env[value.slice(0, eq)] = value.slice(eq + 1);
        break;
      }
      default:
        fail(`unknown option ${key}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`${message}\n\n${USAGE}`);
  process.exit(2);
}

function hashTree(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== "__checks__")
          walk(full);
      } else {
        out.set(
          path.relative(dir, full),
          crypto.createHash("sha1").update(fs.readFileSync(full)).digest("hex"),
        );
      }
    }
  };
  walk(dir);
  return out;
}

const tempDirs = new Set();
function cleanupAll() {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    killAll();
    cleanupAll();
    process.exit(130);
  });
}

/** The user's config cut down to the one model, with the window under test */
function buildConfig(opts, window, mockUrl) {
  if (opts.mock) {
    return [
      "name: eval-mock",
      "version: 1.0.0",
      "schema: v1",
      "models:",
      "  - name: mock-model",
      "    provider: openai",
      "    model: mock-model",
      "    apiKey: mock-key",
      `    apiBase: ${mockUrl}`,
      "    roles: [chat]",
      "    defaultCompletionOptions:",
      `      contextLength: ${window}`,
      "",
    ].join("\n");
  }
  const require = createRequire(import.meta.url);
  let YAML;
  try {
    YAML = require(path.join(cliRoot, "node_modules", "yaml"));
  } catch {
    fail("The yaml package is missing: run `npm ci` in extensions/cli first.");
  }
  const config = YAML.parse(fs.readFileSync(opts.config, "utf8"));
  const model = (config.models ?? []).find((m) => m.name === opts.model);
  if (!model) {
    const names = (config.models ?? []).map((m) => m.name).join(", ");
    fail(`No model named "${opts.model}" in ${opts.config}. It has: ${names}`);
  }
  model.defaultCompletionOptions = {
    ...model.defaultCompletionOptions,
    contextLength: window,
  };
  return YAML.stringify({
    name: config.name ?? "eval",
    version: config.version ?? "1.0.0",
    schema: config.schema ?? "v1",
    models: [model],
  });
}

function secretValues(file) {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .map((line) =>
      line
        .replace(/^[^=]*=/, "")
        .trim()
        .replace(/^["']|["']$/g, ""),
    )
    .filter((value) => value.length >= 8);
}

const runIdOf = (task, window, rep) => `t${task.id}-w${window}-r${rep}`;

async function runOne({
  task,
  window,
  rep,
  opts,
  outDir,
  mockUrl,
  tsc,
  secrets,
}) {
  const runId = runIdOf(task, window, rep);
  const runDir = path.join(outDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `eval-work-${runId}-`));
  const globalDir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cn-"));
  tempDirs.add(globalDir);
  tempDirs.add(workDir);
  const redact = (text) =>
    secrets.reduce((t, s) => t.split(s).join("[redacted]"), text);
  try {
    const { facts, hidden, keepFile } = generateFixture(workDir, {
      task: task.id,
      seed: opts.seed + rep,
    });
    const before = hashTree(workDir);

    // The global dir holds the config and the .env copy; it is deleted below
    const configPath = path.join(globalDir, "config.yaml");
    fs.writeFileSync(configPath, buildConfig(opts, window, mockUrl));
    fs.writeFileSync(
      path.join(globalDir, ".onboarding_complete"),
      new Date().toISOString(),
    );
    if (opts.secretsFile && fs.existsSync(opts.secretsFile)) {
      fs.copyFileSync(opts.secretsFile, path.join(globalDir, ".env"));
      fs.chmodSync(path.join(globalDir, ".env"), 0o600);
    }
    const sessionId = `eval-${runId}`;
    const env = {
      ...process.env,
      ...opts.env,
      PATH: `${path.join(cliRoot, "node_modules", ".bin")}${path.delimiter}${process.env.PATH}`,
      CONTINUE_GLOBAL_DIR: globalDir,
      CONTINUE_CLI_TEST_SESSION_ID: sessionId,
      NEXTCLI_TRACE: opts.trace,
      NEXTCLI_TRACE_DIR: path.join(runDir, "trace"),
    };
    delete env.CONTINUE_CLI_TEST;
    const cnArgs = (extra) => [
      opts.cn,
      "-p",
      "--format",
      "json",
      "--auto",
      "--no-snapshots",
      "--config",
      configPath,
      "--max-cost",
      String(opts.maxCost),
      ...extra,
    ];
    const timeoutMs = opts.timeoutMin * 60_000;

    // The task run
    const main = await exec("node", cnArgs([task.prompt(facts)]), {
      cwd: workDir,
      env,
      timeoutMs,
    });
    fs.writeFileSync(path.join(runDir, "stdout.txt"), redact(main.stdout));
    fs.writeFileSync(path.join(runDir, "stderr.txt"), redact(main.stderr));

    // The success check, with the hidden test files copied in just now
    for (const [rel, text] of Object.entries(hidden)) {
      fs.mkdirSync(path.dirname(path.join(workDir, rel)), { recursive: true });
      fs.writeFileSync(path.join(workDir, rel), text);
    }
    const check = await exec(
      "sh",
      ["-c", task.check(facts).replaceAll("{tsc}", `node ${tsc}`)],
      {
        cwd: workDir,
        env,
        timeoutMs: 120_000,
      },
    );
    fs.writeFileSync(
      path.join(runDir, "check.txt"),
      redact(check.stdout + check.stderr),
    );
    fs.rmSync(path.join(workDir, "__checks__"), {
      recursive: true,
      force: true,
    });

    const after = hashTree(workDir);
    const edited = [...after.keys()].filter(
      (f) => before.get(f) !== after.get(f),
    );
    const keepIntact = before.get(keepFile) === after.get(keepFile);
    const trace = summarizeTrace(
      path.join(runDir, "trace"),
      sessionId,
      workDir,
    );

    // Recall probes: each one resumes the session as the task left it, and
    // the session file is put back afterwards, so a probe sees neither the
    // others nor leaves anything in the metrics (they trace elsewhere)
    const sessionsDir = path.join(globalDir, "sessions");
    const snapshot = path.join(globalDir, "sessions.snapshot");
    // cn can exit before it saved a session: then there is nothing to recall
    const resumable = fs.existsSync(sessionsDir);
    if (resumable) {
      fs.cpSync(sessionsDir, snapshot, { recursive: true });
    }
    const probes = [];
    let probeCostUsd = 0;
    for (const probe of resumable ? task.probes(facts) : []) {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      fs.cpSync(snapshot, sessionsDir, { recursive: true });
      const probeTraceDir = path.join(runDir, "probe-trace", probe.id);
      const prompt = `Answer from memory of this conversation only. Do not use tools. Reply with the answer only.\n\n${probe.question}`;
      const exclude = [
        "Read",
        "List",
        "Search",
        "Bash",
        "Diff",
        "Write",
        "Edit",
        "MultiEdit",
      ].flatMap((t) => ["--exclude", t]);
      const result = await exec(
        "node",
        cnArgs(["--resume", ...exclude, prompt]),
        {
          cwd: workDir,
          env: {
            ...env,
            NEXTCLI_TRACE: "basic",
            NEXTCLI_TRACE_DIR: probeTraceDir,
          },
          timeoutMs: 10 * 60_000,
        },
      );
      const reply = redact(answerOf(result.stdout));
      const grade = gradeProbe(probe, reply, edited);
      probeCostUsd += summarizeTrace(probeTraceDir, sessionId, workDir).costUsd;
      probes.push({
        id: probe.id,
        expected: probe.expected ?? edited,
        reply: reply.slice(0, 2000),
        exitCode: result.code,
        ...grade,
      });
    }

    const summary = parseSummaryLine(main.stderr);
    const calls = trace.calls;
    const graded = probes.filter((p) => !p.na);
    const record = {
      runId,
      task: task.id,
      taskName: task.name,
      window,
      rep,
      model: opts.mock ? "mock-model" : opts.model,
      label: opts.label,
      env: opts.env,
      exitCode: main.code,
      timedOut: main.timedOut,
      wallMs: main.ms,
      status: summary?.status ?? null,
      limitReached: main.code === 3 || summary?.status === "limit",
      checkOk: check.code === 0,
      keepIntact,
      success: check.code === 0 && keepIntact,
      summaryCostUsd: summary?.usage?.cost ?? null,
      ...trace,
      rereads: calls?.rereads ?? null,
      repeatedMax: calls?.repeatedMax ?? null,
      // Both need the request files; without them they are unknown, not 0
      loop: calls ? calls.repeatedMax >= 4 : null,
      editedFiles: edited,
      // A probe with nothing to recall (no file edited) isn't counted
      recallCorrect: graded.filter((p) => p.ok).length,
      recallTotal: graded.length,
      recallScore: graded.length
        ? graded.reduce((s, p) => s + p.score, 0) / graded.length
        : null,
      probeCostUsd,
      probes,
    };
    delete record.calls;
    if (opts.keepWork) {
      fs.cpSync(workDir, path.join(runDir, "work"), { recursive: true });
    }
    return record;
  } finally {
    fs.rmSync(globalDir, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
    tempDirs.delete(globalDir);
    tempDirs.delete(workDir);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  opts.cn = path.resolve(opts.cn ?? path.join(cliRoot, "dist", "cn.js"));
  if (!opts.mock && !opts.dryRun && (!opts.config || !opts.model)) {
    fail("--config and --model are required (or use --mock)");
  }
  if (opts.mock && !opts.model) opts.model = "mock-model";
  opts.label ??=
    Object.entries(opts.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ") || "default";
  if (!opts.dryRun && !fs.existsSync(opts.cn)) {
    fail(`${opts.cn} not found: run \`npm run build\` in extensions/cli`);
  }
  const selected = tasks.filter((t) => opts.tasks.includes(t.id));
  if (selected.length === 0) fail("no such task");
  const runs = selected.length * opts.windows.length * opts.reps;
  const outDir = path.resolve(
    opts.out ??
      path.join(
        here,
        "results",
        new Date().toISOString().replace(/[:.]/g, "-"),
      ),
  );
  const tsc = path.join(cliRoot, "node_modules", "typescript", "bin", "tsc");
  const globalDefault =
    process.env.CONTINUE_GLOBAL_DIR ?? path.join(os.homedir(), ".continue");
  opts.secretsFile = opts.mock
    ? null
    : path.resolve(opts.secrets ?? path.join(globalDefault, ".env"));
  const secrets = secretValues(opts.secretsFile);

  console.log(
    `${runs} runs (${selected.length} tasks x ${opts.windows.length} windows x ${opts.reps} reps), model ${opts.model}, label "${opts.label}", per-call cap $${opts.maxCost}`,
  );
  if (opts.dryRun) {
    for (const task of selected) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "eval-dry-"));
      const { facts } = generateFixture(scratch, {
        task: task.id,
        seed: opts.seed,
      });
      console.log(`\ntask ${task.id}: ${task.name}`);
      console.log(`  check: ${task.check(facts)}`);
      console.log(
        `  probes: ${task
          .probes(facts)
          .map((p) => p.id)
          .join(", ")}`,
      );
      fs.rmSync(scratch, { recursive: true, force: true });
    }
    console.log(`\nwould write to ${outDir}; nothing was called`);
    return;
  }
  if (!opts.mock) {
    console.log(
      "This spends the API key in --config. Ctrl+C stops it; temp config copies are deleted.",
    );
  }
  fs.mkdirSync(outDir, { recursive: true });
  const mock = opts.mock ? await startMockServer() : null;
  const results = path.join(outDir, "results.jsonl");
  let spent = 0;
  try {
    for (const window of opts.windows) {
      for (const task of selected) {
        for (let rep = 1; rep <= opts.reps; rep++) {
          if (opts.maxTotalCost !== undefined && spent >= opts.maxTotalCost) {
            console.log(
              `Stopping: spent $${spent.toFixed(2)} of --max-total-cost $${opts.maxTotalCost}`,
            );
            return;
          }
          let record;
          mock?.reset();
          try {
            record = await runOne({
              task,
              window,
              rep,
              opts,
              outDir,
              mockUrl: mock?.url,
              tsc,
              secrets,
            });
          } catch (error) {
            // One broken run is a row, not the end of the matrix
            record = {
              runId: runIdOf(task, window, rep),
              task: task.id,
              taskName: task.name,
              window,
              rep,
              model: opts.model,
              label: opts.label,
              success: false,
              error: String(error?.stack ?? error).split("\n")[0],
              wallMs: 0,
            };
            console.error(`${record.runId}: failed to run: ${record.error}`);
          }
          fs.appendFileSync(results, JSON.stringify(record) + "\n");
          spent += (record.costUsd ?? 0) + (record.probeCostUsd ?? 0);
          if (record.error) continue;
          console.log(
            `${record.runId}: ${record.success ? "ok" : "FAIL"} exit=${record.exitCode} compactions=${record.compactions} recall=${record.recallCorrect}/${record.recallTotal} cost=$${(record.costUsd ?? 0).toFixed(3)} ${(record.wallMs / 1000).toFixed(0)}s`,
          );
        }
      }
    }
  } finally {
    await mock?.close();
    cleanupAll();
    if (fs.existsSync(results)) {
      writeReport([results], path.join(outDir, "report.md"));
      console.log(
        `\nresults: ${results}\nreport:  ${path.join(outDir, "report.md")}`,
      );
    }
  }
}

main().catch((error) => {
  cleanupAll();
  console.error(error);
  process.exit(1);
});
