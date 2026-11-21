---
name: CLI runtime
description: Run modes, cancellation and context accounting in the cn CLI
alwaysApply: false
globs:
  - "**/extensions/cli/src/**"
paths:
  - "**/extensions/cli/src/**"
---

# CLI runtime

- **Every run mode.** For a behavior change, say what happens in the TUI, headless `-p`, `cn serve`, `cn review` workers, `--readonly` and subagents, and test the modes that differ. `cn serve` has a client that can answer questions; headless has nobody.
- **Cancellation.** A nested stream (compaction, summary, subagent) must not replace or unregister the turn's abort controller (`src/util/abortRegistry.ts`). Escape or Ctrl+C in the middle of a tool call leaves no sibling tool running and no half-updated session.
- **One definition of what is sent.** `historySentToModel` (`src/util/tokenizer.ts`) decides which history items a request carries. Token counts, pruning and compaction use it, and fit decisions use the same `validateContextLength` check as the request. No second arithmetic.
- **Compaction never loses the session.** A pruned request view is never stored as the session. Compaction fails closed (session unchanged) when the newest turn doesn't fit or the summary is empty, keeps a leading earlier summary, and reports what it omitted in every mode (stderr when headless). Fit order: older tool outputs oldest first, then older turns, then the newest step's outputs last.
- **Limits hold for every model call.** A new call path (summaries, retries, subagents) counts against `--max-turns`, `--max-session-tokens` and `--max-cost` (`src/stream/agentLoopLimits.ts`).
- **Diagnostics cost nothing when off.** New logs, traces or metrics sit behind a log level, env var or flag. Per-call data goes through `recordStreamTelemetry` / `recordFailedCall` in `src/stream/`, not a new module.
