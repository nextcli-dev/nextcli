import fs from "fs";
import path from "path";

import { isSecretEnvVar } from "@continuedev/terminal-security";
import { ModelConfig, parseTraceLevel } from "@nextcli/config-yaml";
import {
  AdapterRequest,
  observeAdapterRequests,
} from "@nextcli/openai-adapters";

import { env } from "../env.js";
import { getCurrentSession } from "../session.js";
import { logger, warnBadEnv } from "../util/logger.js";
import { getVersion } from "../version.js";

// NEXTCLI_TRACE=basic writes one JSON line per model call: timings, token
// counts and tool names. `full` also writes each request the model adapters
// post to <traceDir>/<sessionId>-<runId>/request-<n>.json, secrets redacted.
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
function traceFullEnabled(): boolean {
  return parseTraceLevel(process.env.NEXTCLI_TRACE) === "full";
}

// The full-mode request folder: null once a write failed, undefined until
// the first request. Like the trace file, read at the first request.
let requestDir: string | null | undefined = undefined;
let requestCount = 0;

type TracedModel = Pick<ModelConfig, "apiKey" | "env" | "requestOptions">;

// The models whose credentials are redacted from request files
const tracedModels: TracedModel[] = [];

const REDACTED = "[redacted]";

// Header names whose values are credentials, besides the env filter's rules
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
]);

/**
 * NEXTCLI_TRACE=full: from now on, writes each request the model adapters
 * post, with this model's credentials redacted. createLlmApi calls it for
 * every model it builds. Off and basic do nothing.
 */
export function traceModelRequests(model: TracedModel): void {
  if (!traceFullEnabled()) {
    return;
  }
  tracedModels.push(model);
  observeAdapterRequests(traceRequest);
}

/** The client key as fetch reads it: a data: URI or a file path */
function clientKeyCredentials(key: string): string[] {
  try {
    if (key.startsWith("data:")) {
      const [header, data] = key.split(",");
      const text = header.includes("base64")
        ? Buffer.from(data, "base64").toString("utf8")
        : decodeURIComponent(data);
      return [key, text.trim()];
    }
    return [fs.readFileSync(key, "utf8").trim()];
  } catch {
    return key.startsWith("data:") ? [key] : [];
  }
}

/**
 * A model's configured credentials, whatever their length: a field that
 * holds a credential is one even when it is short. Entries of its `env`
 * follow the rule for environment variables instead.
 */
function modelCredentials(model: TracedModel): string[] {
  const credentials: string[] = [];
  if (model.apiKey) {
    credentials.push(model.apiKey);
  }
  for (const [name, value] of Object.entries(
    model.requestOptions?.headers ?? {},
  )) {
    if (
      CREDENTIAL_HEADERS.has(name.toLowerCase()) ||
      isSecretEnvVar(name.replace(/-/g, "_"), value)
    ) {
      credentials.push(value);
      // The token of "Bearer <token>" can appear on its own
      const token = /^\S+\s+(\S+)$/.exec(value)?.[1];
      if (token) {
        credentials.push(token);
      }
    }
  }
  const certificate = model.requestOptions?.clientCertificate;
  if (certificate?.passphrase) {
    credentials.push(certificate.passphrase);
  }
  if (certificate?.key) {
    credentials.push(...clientKeyCredentials(certificate.key));
  }
  return credentials;
}

/**
 * The strings to redact from a request file: every traced model's
 * credentials, and values of secret-like environment variables (the rules
 * the Bash tool's env filter uses) from the process and from each model's
 * `env`. An environment value needs 8 characters or more, because any
 * variable called *_KEY matches; a YAML number counts as its digits.
 */
function secretValues(): string[] {
  const secrets = new Set<string>();
  const environments = [
    Object.entries(process.env),
    ...tracedModels.map((model) => Object.entries(model.env ?? {})),
  ];
  for (const entries of environments) {
    for (const [name, value] of entries) {
      if (typeof value !== "string" && typeof value !== "number") {
        continue;
      }
      const text = String(value);
      if (text.length >= 8 && isSecretEnvVar(name, text)) {
        secrets.add(text);
      }
    }
  }
  for (const model of tracedModels) {
    for (const credential of modelCredentials(model)) {
      secrets.add(credential);
    }
  }
  secrets.delete("");
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
  if (typeof value === "number") {
    const digits = String(value);
    return secrets.some((secret) => digits.includes(secret)) ? REDACTED : value;
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

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

/**
 * Writes one request a model adapter posts, under NEXTCLI_TRACE=full, as
 * <traceDir>/<sessionId>-<runId>/request-<n>.json: the method, the URL and
 * the body in the provider's format, as sent. These files hold the exact
 * prompts: PR text and source code. Credentials are redacted; nothing else
 * is. Only the owner can read them. Synchronous, like traceEvent, so a run
 * that fails keeps its last request.
 */
function traceRequest(request: AdapterRequest): void {
  if (requestDir === null || !traceFullEnabled()) {
    return;
  }
  try {
    if (requestDir === undefined) {
      const dir =
        process.env.NEXTCLI_TRACE_DIR || path.join(env.continueHome, "traces");
      const { sessionId } = getCurrentSession();
      requestDir = path.join(dir, `${sessionId}-${logger.getRunId()}`);
      fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
    }
    const record = {
      ts: Date.now(),
      method: request.method,
      url: request.url,
      body: parseBody(request.body),
    };
    requestCount += 1;
    fs.writeFileSync(
      path.join(requestDir, `request-${requestCount}.json`),
      JSON.stringify(redactSecrets(record, secretValues()), null, 2),
      { mode: 0o600 },
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
