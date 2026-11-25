# Context eval

A hand-run harness that measures how `cn` copes with long agent tasks when its context fills up and compaction runs. It exists to give the current compaction ("legacy") a baseline, and to compare it with a new strategy later.

It is not part of CI and not in the npm package (`package.json` `files` lists only `dist`). Nothing here runs unless you start it.

## What it measures

Each run is one task, in one context window, for one repetition:

1. `fixture/generate.mjs` writes a small TypeScript repo into a temp folder. It is seeded, so a seed gives the same files. It plants exact facts: a requirement in the prompt, a value in a file the run reads, a vendored file that must stay untouched, an error from `scripts/verify.mjs` with a code and a fix.
2. `cn -p --format json` does the task (`tasks.mjs` has the 7 tasks), with `NEXTCLI_TRACE=full` on.
3. A shell check says whether the task succeeded, plus whether the vendored file is unchanged.
4. Five recall probes are asked afterwards, each in the resumed session (`--resume`, tools excluded): the requirement from message 1, a value read from a tool output, a decision made mid-run, the list of files edited, and an error and its fix. Each has an exact expected answer.

Per run (`results.jsonl`): success, compactions (compacted, failed, cancelled), input, cached and output tokens, cost, wall time, exit code 3 (a limit was reached), repeated identical tool calls (`loop` is 4 or more), recall accuracy, and files re-read after a compaction. The compaction numbers come from the `context.compaction` trace events (trigger, tokens before and after, what the summary request cut, duration), the token and cost numbers from the `llm.request` lines.

Re-reads need the tool arguments, and a `basic` trace only has tool names. So the runner defaults to `NEXTCLI_TRACE=full`, whose request files hold the whole conversation, and takes every `Read` call from them. A re-read is a `Read` of a path that an earlier `Read` already returned, after a compaction in between. With `--trace basic` the re-read column is `n/a`.

How the probes stay out of the metrics: they write their own trace to `<run>/probe-trace/`, and the session file is put back to what the task left before each probe, so a probe never sees another one. Their cost is reported separately.

## Run it

Install and build the CLI first:

```bash
cd extensions/cli && npm ci && npm run build
```

`--config` is a `cn` config.yaml with the model. The runner copies it into a temp `CONTINUE_GLOBAL_DIR`, keeps only the named model and sets its `defaultCompletionOptions.contextLength` to each window. It copies the `.env` that holds the `${{ secrets.X }}` values (`--secrets`, default `~/.continue/.env`) next to it, and deletes the whole folder when the run ends. The saved stdout and stderr have those values replaced.

Cost warning: this spends your API key. One run is a whole agent job plus 5 probes; 7 tasks x 2 windows x 3 reps is 42 runs. Pilot first:

```bash
node eval/context/run.mjs --config ~/cn-eval.yaml --model my-model \
  --tasks 1 --windows 64000 --reps 1 --max-cost 2
```

`--max-cost` caps each cn call. `--max-total-cost` stops starting new runs once the runs so far cost that much. Check the plan without calling anything:

```bash
node eval/context/run.mjs --dry-run --tasks 1,2
```

The full baseline:

```bash
node eval/context/run.mjs --config ~/cn-eval.yaml --model my-model \
  --windows 64000,128000 --reps 3 --max-cost 5 --max-total-cost 150 \
  --label legacy --out eval/context/results/legacy
```

Options: `--tasks 1,2,...`, `--cn <dist/cn.js>`, `--seed`, `--timeout-min`, `--keep-work` (keep each project folder under the run's folder), `--trace basic|full`.

Output in `--out` (default `eval/context/results/<time>/`, which git ignores): `results.jsonl` (one line per run), `report.md` (a table per window, one row per task, median / mean per metric), and per run `stdout.txt`, `stderr.txt`, `check.txt`, `trace/`, `probe-trace/`.

To rebuild a report, or put several result files in one: `node eval/context/report.mjs a/results.jsonl b/results.jsonl`.

## Compare two strategies

`--env KEY=VALUE` (repeatable) adds environment variables to every cn call. Run the same tasks, windows, reps and seed twice and give each a label:

```bash
node eval/context/run.mjs --config ~/cn-eval.yaml --model my-model --label legacy \
  --env NEXTCLI_COMPACTION=legacy --out eval/context/results/legacy
node eval/context/run.mjs --config ~/cn-eval.yaml --model my-model --label checkpoint \
  --env NEXTCLI_COMPACTION=checkpoint --out eval/context/results/checkpoint
node eval/context/report.mjs eval/context/results/legacy/results.jsonl \
  eval/context/results/checkpoint/results.jsonl > eval/context/results/compare.md
```

The report then has a table per window and label. (`NEXTCLI_COMPACTION` does not exist yet; any variable works the same.)

## Smoke test without a provider

`--mock` points cn at a local fake model (`mock-server.mjs`) and needs no config or key:

```bash
node eval/context/run.mjs --mock --tasks 5 --windows 64000 --reps 1 --out /tmp/eval-smoke
```

The fake reads the three logs and one of them again, writes a canned summary when asked to compact, and gives a canned reply to every probe. So the task fails its check and recall is low. It only proves the pipeline: generate, run, check, probes, metrics, report. The numbers mean nothing.

## Limits

- The fixture is small and synthetic. It stresses context by size (about 50K to 75K tokens of reads per task), not by difficulty.
- The compaction summary request is found by the time window of its `context.compaction` event. A strategy that compacts without a summary request will show compactions but no compaction cost.
- Cost uses cn's own price table (`priced` in the trace); a model with an estimated price gives an estimated cost.
