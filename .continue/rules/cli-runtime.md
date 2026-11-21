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
- **Compaction never loses the session.** A fitted request view is never stored as the session. Compaction sizes the summary for the next request (system prompt, tools, what follows) and writes nothing, not even from the summary stream, until the result passes that request's check; otherwise it fails closed with the session unchanged. An empty summary fails the same way. It keeps a leading earlier summary and reports what it cut in every mode (stderr when headless). Fit order: older tool outputs cut to one cap (the largest that fits, so the longest shrink first), then older turns, then the last step's outputs. Only tool output is cut.
- **Limits hold for every model call.** A new call path (summaries, retries, subagents) counts against `--max-turns`, `--max-session-tokens` and `--max-cost` (`src/stream/agentLoopLimits.ts`).
- **Diagnostics cost nothing when off.** New logs, traces or metrics sit behind a log level, env var or flag. Per-call data goes through `recordStreamTelemetry` / `recordFailedCall` in `src/stream/`, not a new module.
