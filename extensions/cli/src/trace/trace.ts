import fs from "fs";
import path from "path";

import { isSecretEnvVar } from "@continuedev/terminal-security";
import { parseTraceLevel } from "@nextcli/config-yaml";

import { env } from "../env.js";
import { getCurrentSession } from "../session.js";
import { logger, warnBadEnv } from "../util/logger.js";
import { getVersion } from "../version.js";

// NEXTCLI_TRACE=basic writes one JSON line per model call: timings, token
// counts and tool names. `full` also writes each request payload to
// <traceDir>/<sessionId>-<runId>/request-<n>.json, with secrets redacted.
// Read once, at the first event, so a trusted folder's .env (loaded after
// modules load) can set it. The levels are shared with core's dev-data
// logging, so one shell export works for both.

/** True for a recognised NEXTCLI_TRACE level. An unknown value stays off. */
export function traceEnabled(): boolean {
  return parseTraceLevel(process.env.NEXTCLI_TRACE) !== undefined;
}

function traceOn(): boolean {
  const rawLevel = process.env.NEXTCLI_TRACE;
  if (rawLevel?.trim() && !parseTraceLevel(rawLevel)) {
    warnBadEnv(
      `Unknown NEXTCLI_TRACE "${rawLevel}", tracing is off. Use basic or full.`,
    );
  }
  return traceEnabled();
}

// Not read yet; then the open trace file, or null when tracing is off
const NOT_READ = Symbol("not read");
let tracePath: string | null | undefined | typeof NOT_READ = NOT_READ;

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

/** True only for NEXTCLI_TRACE=full: request payloads are written too. */
export function traceFullEnabled(): boolean {
  return parseTraceLevel(process.env.NEXTCLI_TRACE) === "full";
}

// The full-mode request folder: null once a write failed, undefined until
// the first request. Like the trace file, read at the first request.
let requestDir: string | null | undefined = undefined;
let requestCount = 0;

const REDACTED = "[redacted]";

/**
 * The secret strings to redact from a request payload: values of secret-like
 * environment variables (the same rules the Bash tool's env filter uses),
 * plus the model's configured apiKey and secret-like entries of its `env`.
 */
function secretValues(model?: {
  apiKey?: string;
  env?: Record<string, string | boolean | number>;
}): string[] {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (value && value.length >= 8 && isSecretEnvVar(name, value)) {
      secrets.add(value);
    }
  }
  if (model?.apiKey && model.apiKey.length >= 8) {
    secrets.add(model.apiKey);
  }
  for (const [name, value] of Object.entries(model?.env ?? {})) {
    const text = String(value);
    if (text.length >= 8 && isSecretEnvVar(name, text)) {
      secrets.add(text);
    }
  }
  // Longest first, so a secret containing another is replaced whole
  return [...secrets].sort((a, b) => b.length - a.length);
}

function redactSecrets(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") {
    let text = value;
    for (const secret of secrets) {
      if (text.includes(secret)) {
        text = text.split(secret).join(REDACTED);
      }
    }
    return text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, secrets));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactSecrets(item, secrets),
      ]),
    );
  }
  return value;
}

/**
 * Writes one request payload under NEXTCLI_TRACE=full, as
 * <traceDir>/<sessionId>-<runId>/request-<n>.json. These files hold the exact
 * prompts: PR text and source code. Secrets are redacted; nothing else is.
 * Off and basic compute nothing. Synchronous, like traceEvent, so a run that
 * fails keeps its last request.
 */
export function traceRequest(payload: Record<string, unknown>): void {
  if (requestDir === null || !traceFullEnabled()) {
    return;
  }
  try {
    if (requestDir === undefined) {
      const dir =
        process.env.NEXTCLI_TRACE_DIR || path.join(env.continueHome, "traces");
      const { sessionId } = getCurrentSession();
      requestDir = path.join(dir, `${sessionId}-${logger.getRunId()}`);
      fs.mkdirSync(requestDir, { recursive: true });
    }
    const secrets = secretValues(
      payload as { apiKey?: string; env?: Record<string, any> },
    );
    const redacted = redactSecrets(payload, secrets);
    requestCount += 1;
    fs.writeFileSync(
      path.join(requestDir, `request-${requestCount}.json`),
      JSON.stringify(redacted, null, 2),
    );
  } catch (error) {
    logger.warn("Could not write the request file, full tracing is off", {
      error,
    });
    requestDir = null;
  }
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
  if (tracePath === NOT_READ) {
    tracePath = traceOn() ? undefined : null;
  }
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
