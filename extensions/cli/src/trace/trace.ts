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

// NEXTCLI_TRACE=basic writes one JSON line per model call to
// <traceDir>/<sessionId>-<runId>.jsonl: timings, token counts and tool names.
// `full` also writes each request the model adapters post to
// <traceDir>/<sessionId>-<runId>/request-<n>.json, secrets redacted. Both
// follow the current session, so a new or resumed session gets its own. The
// level is read once, at the first event, so a trusted folder's .env (loaded
// after modules load) can set it. The levels are shared with core's dev-data
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

// Not read yet, then whether tracing is on; off for good after a failed write
const NOT_READ = Symbol("not read");
let tracing: boolean | typeof NOT_READ = NOT_READ;
// The trace files this run has written a header to
const startedTraces = new Set<string>();

/** The trace folder and the current session's name in it */
function traceTarget() {
  const dir =
    process.env.NEXTCLI_TRACE_DIR || path.join(env.continueHome, "traces");
  const { sessionId } = getCurrentSession();
  const runId = logger.getRunId();
  return { dir, sessionId, runId, name: `${sessionId}-${runId}` };
}

/** The current session's trace file, with a header the first time */
function currentTrace(): string {
  const { dir, sessionId, runId, name } = traceTarget();
  const file = path.join(dir, `${name}.jsonl`);
  if (!startedTraces.has(file)) {
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
    startedTraces.add(file);
  }
  return file;
}

/** True only for NEXTCLI_TRACE=full: request payloads are written too. */
function traceFullEnabled(): boolean {
  return parseTraceLevel(process.env.NEXTCLI_TRACE) === "full";
}

// Requests written to each session's folder; none after a failed write
const requestCounts = new Map<string, number>();
let requestFilesOff = false;

type TracedModel = Pick<
  ModelConfig,
  "provider" | "model" | "apiKey" | "env" | "requestOptions"
>;

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
 * The model requests an SDK sends past the adapters' fetch, if this model
 * makes any. On Vertex AI only Gemini streams through @google/genai; Claude,
 * Mistral and non-streaming Gemini go through customFetch (the adapter's
 * determineVertexProvider order).
 */
function unrecordedRequests(model: TracedModel): string | undefined {
  switch (model.provider) {
    case "bedrock":
      return "Bedrock";
    case "gemini":
      return "Gemini";
    case "vertexai":
      return model.model.includes("gemini") &&
        !/mistral|codestral|mixtral|claude/.test(model.model)
        ? "Vertex AI Gemini streaming"
        : undefined;
    default:
      return undefined;
  }
}
const warnedUnrecorded = new Set<string>();

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
  const unrecorded = unrecordedRequests(model);
  if (unrecorded && !warnedUnrecorded.has(unrecorded)) {
    warnedUnrecorded.add(unrecorded);
    warnBadEnv(
      `NEXTCLI_TRACE=full can't write ${unrecorded} requests: an SDK sends them. Their trace lines are still written.`,
    );
  }
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
 * The user:password a base64 credential encodes (a Basic token, an on-prem
 * WatsonX apiKey) and that password, each when 8 characters or more: a
 * shorter one, such as the "a" of user:a, would redact common words.
 */
function decodedCredentials(encoded: string): string[] {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    return [];
  }
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  if (!/^[\x20-\x7e]+$/.test(decoded) || !decoded.includes(":")) {
    return [];
  }
  const password = decoded.slice(decoded.indexOf(":") + 1).trim();
  return [decoded, password].filter((part) => part.length >= 8);
}

/**
 * A credential header's value and the secrets inside it: the token after a
 * scheme ("Bearer <token>"), what a Basic token encodes, and cookie values of
 * 8 characters or more (shorter ones are settings such as theme=dark, and
 * would redact common words).
 */
function headerCredentials(name: string, value: string): string[] {
  const credentials = [value];
  const [, scheme, token] = /^(\S+)\s+(\S+)$/.exec(value) ?? [];
  if (token) {
    credentials.push(token);
    if (scheme.toLowerCase() === "basic") {
      credentials.push(...decodedCredentials(token));
    }
  }
  if (name.toLowerCase() === "cookie") {
    for (const pair of value.split(";")) {
      const cookie = pair.slice(pair.indexOf("=") + 1).trim();
      if (pair.includes("=") && cookie.length >= 8) {
        credentials.push(cookie);
      }
    }
  }
  return credentials;
}

/**
 * A model's configured credentials, whatever their length: a field that
 * holds a credential is one even when it is short. Entries of its `env`
 * follow the rule for environment variables instead, and parts decoded from
 * a credential need 8 characters.
 */
function modelCredentials(model: TracedModel): string[] {
  const credentials: string[] = [];
  if (model.apiKey) {
    credentials.push(model.apiKey, ...decodedCredentials(model.apiKey));
  }
  for (const [name, value] of Object.entries(
    model.requestOptions?.headers ?? {},
  )) {
    if (
      CREDENTIAL_HEADERS.has(name.toLowerCase()) ||
      isSecretEnvVar(name.replace(/-/g, "_"), value)
    ) {
      credentials.push(...headerCredentials(name, value));
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
 * variable called *_KEY matches; a YAML number counts as its digits. Each
 * also in its URL-encoded forms, as a key in a query string is written.
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
  for (const secret of [...secrets]) {
    secrets.add(encodeURIComponent(secret));
    secrets.add(new URLSearchParams({ s: secret }).toString().slice(2));
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
  if (requestFilesOff || !traceFullEnabled()) {
    return;
  }
  try {
    const { dir, name } = traceTarget();
    const requestDir = path.join(dir, name);
    const count = (requestCounts.get(requestDir) ?? 0) + 1;
    if (count === 1) {
      fs.mkdirSync(requestDir, { recursive: true, mode: 0o700 });
    }
    const record = {
      ts: Date.now(),
      method: request.method,
      url: request.url,
      body: parseBody(request.body),
    };
    fs.writeFileSync(
      path.join(requestDir, `request-${count}.json`),
      JSON.stringify(redactSecrets(record, secretValues()), null, 2),
      { mode: 0o600 },
    );
    requestCounts.set(requestDir, count);
  } catch (error) {
    logger.warn("Could not write the request file, full tracing is off", {
      error,
    });
    requestFilesOff = true;
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
  if (tracing === NOT_READ) {
    tracing = traceOn();
  }
  if (!tracing) {
    return;
  }
  try {
    fs.appendFileSync(
      currentTrace(),
      JSON.stringify({ ts: timing.ts, dur: timing.dur, name, attrs }) + "\n",
    );
  } catch (error) {
    logger.warn("Could not write the trace file, tracing is off", { error });
    tracing = false;
  }
}
