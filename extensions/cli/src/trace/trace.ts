import fs from "fs";
import path from "path";

import { env } from "../env.js";
import { getCurrentSession } from "../session.js";
import { logger, warnBadEnv } from "../util/logger.js";
import { getVersion } from "../version.js";

// NEXTCLI_TRACE=basic writes one JSON line per model call: timings, token
// counts and tool names. Read once, when cn starts.
const rawLevel = process.env.NEXTCLI_TRACE;
const level = rawLevel?.trim().toLowerCase();
if (level && level !== "basic") {
  warnBadEnv(`Unknown NEXTCLI_TRACE "${rawLevel}", tracing is off. Use basic.`);
}

// undefined until the first event opens the file; null when tracing is off
let tracePath: string | null | undefined = level === "basic" ? undefined : null;

function openTrace(): string {
  const dir =
    process.env.NEXTCLI_TRACE_DIR || path.join(env.continueHome, "traces");
  const { sessionId } = getCurrentSession();
  const runId = logger.getRunId();
  const file = path.join(dir, `${sessionId}-${runId}.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  const header = {
    version: getVersion(),
    node: process.version,
    platform: process.platform,
    runId,
    sessionId,
  };
  fs.appendFileSync(
    file,
    JSON.stringify({ ts: Date.now(), name: "header", attrs: header }) + "\n",
  );
  return file;
}

/**
 * Appends one event to the trace file. Writes are synchronous, so a run that
 * fails or exits early keeps its last events.
 */
export function traceEvent(
  name: string,
  attrs: Record<string, unknown>,
  timing: { ts: number; dur?: number },
): void {
  if (tracePath === null) {
    return;
  }
  try {
    tracePath ??= openTrace();
    fs.appendFileSync(
      tracePath,
      JSON.stringify({ ts: timing.ts, dur: timing.dur, name, attrs }) + "\n",
    );
  } catch (error) {
    logger.warn("Could not write the trace file, tracing is off", { error });
    tracePath = null;
  }
}
