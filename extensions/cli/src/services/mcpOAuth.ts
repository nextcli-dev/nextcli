import { randomUUID } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthTokensSchema,
  type OAuthClientInformationMixed,
  type OAuthClientMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { env } from "../env.js";
import { logger } from "../util/logger.js";

/**
 * Native OAuth for remote (HTTP/SSE) MCP servers.
 *
 * The MCP SDK transports run discovery, client registration, PKCE and token
 * refresh through an `OAuthClientProvider`. This module supplies that provider
 * for the CLI: credentials persist in `<continueHome>/mcp-oauth.json` (mode
 * 0600), and the browser redirect lands on a short-lived loopback listener.
 */

export const DEFAULT_MCP_OAUTH_PORT = 33418;
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const SUPABASE_SCOPES = [
  "organizations:read",
  "projects:read",
  "database:read",
  "analytics:read",
  "secrets:read",
  "edge_functions:read",
  "environment:read",
  "storage:read",
].join(" ");

interface StoredServerEntry {
  clientInformation?: OAuthClientInformationMixed;
  /** redirect_uri the client was registered with */
  redirectUri?: string;
  tokens?: OAuthTokens;
}

type StoredOAuthFile = Record<string, StoredServerEntry>;

export function getMcpOAuthStoragePath(): string {
  return path.join(env.continueHome, "mcp-oauth.json");
}

export function getMcpOAuthPort(): number {
  const raw = process.env.NEXTCLI_MCP_OAUTH_PORT;
  if (raw) {
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536) {
      return port;
    }
    logger.warn(`Ignoring invalid NEXTCLI_MCP_OAUTH_PORT: ${raw}`);
  }
  return DEFAULT_MCP_OAUTH_PORT;
}

export function getMcpOAuthRedirectUrl(): string {
  return `http://127.0.0.1:${getMcpOAuthPort()}${MCP_OAUTH_CALLBACK_PATH}`;
}

function readStore(): StoredOAuthFile {
  try {
    const raw = fs.readFileSync(getMcpOAuthStoragePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(store: StoredOAuthFile): void {
  const file = getMcpOAuthStoragePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename keeps the temp file's mode, but tighten in case the file pre-existed
  // with looser permissions on platforms where that matters.
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Not fatal (e.g. Windows).
  }
}

function updateEntry(
  serverUrl: string,
  update: (entry: StoredServerEntry) => StoredServerEntry | undefined,
): void {
  const store = readStore();
  const next = update({ ...(store[serverUrl] ?? {}) });
  if (next && Object.keys(next).length > 0) {
    store[serverUrl] = next;
  } else {
    delete store[serverUrl];
  }
  writeStore(store);
}

export function hasStoredMcpOAuthTokens(serverUrl: string): boolean {
  return !!readStore()[serverUrl]?.tokens;
}

/** Remove all stored OAuth credentials for a server (sign out). */
export function clearMcpOAuth(serverUrl: string): void {
  updateEntry(serverUrl, () => undefined);
}

// ---------------------------------------------------------------------------
// Loopback callback listener
// ---------------------------------------------------------------------------

interface PendingFlow {
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingFlows = new Map<string, PendingFlow>();
let callbackServer: http.Server | null = null;
let callbackServerReady: Promise<void> | null = null;

function respond(res: http.ServerResponse, status: number, message: string) {
  // Connection: close so a keep-alive socket can't outlive the listener.
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    Connection: "close",
  });
  res.end(
    `<!DOCTYPE html><html><head><title>NextCLI</title></head><body><p>${message}</p></body></html>`,
  );
}

function settleFlow(state: string, outcome: { code?: string; error?: Error }) {
  const flow = pendingFlows.get(state);
  if (!flow) return;
  pendingFlows.delete(state);
  clearTimeout(flow.timer);
  if (outcome.code === undefined) {
    flow.reject(outcome.error ?? new Error("OAuth sign-in failed"));
  } else {
    flow.resolve(outcome.code);
  }
  if (pendingFlows.size === 0) {
    closeCallbackServer();
  }
}

function closeCallbackServer() {
  const server = callbackServer;
  callbackServer = null;
  callbackServerReady = null;
  server?.close();
}

function handleCallbackRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method !== "GET" || url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
    respond(res, 404, "Not found.");
    return;
  }

  const state = url.searchParams.get("state");
  if (!state || !pendingFlows.has(state)) {
    respond(res, 400, "Unknown or expired sign-in request.");
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description");
    respond(res, 400, "Sign-in failed. You can close this tab.");
    settleFlow(state, {
      error: new Error(
        `OAuth authorization failed: ${error}${description ? ` (${description})` : ""}`,
      ),
    });
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    respond(res, 400, "Missing authorization code.");
    settleFlow(state, {
      error: new Error("OAuth callback did not include an authorization code"),
    });
    return;
  }

  respond(res, 200, "Sign-in complete. You can close this tab.");
  settleFlow(state, { code });
}

async function ensureCallbackServer(): Promise<void> {
  if (callbackServerReady) return callbackServerReady;

  const port = getMcpOAuthPort();
  const server = http.createServer(handleCallbackRequest);
  callbackServer = server;
  callbackServerReady = new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      closeCallbackServer();
      reject(
        new Error(
          err.code === "EADDRINUSE"
            ? `Cannot start the MCP OAuth callback listener: port ${port} is in use. Set NEXTCLI_MCP_OAUTH_PORT to a free port.`
            : `Cannot start the MCP OAuth callback listener: ${err.message}`,
        ),
      );
    };
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", onError);
      server.unref();
      resolve();
    });
  });
  return callbackServerReady;
}

/**
 * Start listening for the OAuth redirect for `state`. Resolves once the
 * listener is up; the returned `code` promise settles when the browser hits
 * the callback, on an OAuth error, or on timeout.
 */
export async function startAuthorizationCallback(
  state: string,
  { timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {},
): Promise<{ code: Promise<string> }> {
  await ensureCallbackServer();

  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      settleFlow(state, {
        error: new Error(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for OAuth sign-in`,
        ),
      });
    }, timeoutMs);
    timer.unref();
    pendingFlows.set(state, { resolve, reject, timer });
  });
  // Avoid an unhandled rejection if nobody is awaiting yet; awaiters still see it.
  code.catch(() => {});
  return { code };
}

/** Cancel all in-flight sign-ins (used on shutdown and in tests). */
export function cancelAllMcpOAuthFlows(reason = "OAuth sign-in cancelled") {
  for (const state of Array.from(pendingFlows.keys())) {
    settleFlow(state, { error: new Error(reason) });
  }
  closeCallbackServer();
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CliMcpOAuthProviderOptions {
  /** When false, never open a browser or listen for a callback. */
  interactive: boolean;
  /** Called with the authorization URL when browser sign-in starts. */
  onAuthorizationUrl?: (url: URL) => void;
  /** Override how the browser is opened (tests). */
  openBrowser?: (url: string) => Promise<unknown>;
  timeoutMs?: number;
}

async function defaultOpenBrowser(url: string) {
  const open = (await import("open")).default;
  return open(url);
}

export class CliMcpOAuthProvider implements OAuthClientProvider {
  private _codeVerifier: string | undefined;
  private _state: string | undefined;
  private _pendingCode: Promise<string> | undefined;

  constructor(
    public readonly serverUrl: string,
    private readonly options: CliMcpOAuthProviderOptions,
  ) {}

  get redirectUrl(): string {
    return getMcpOAuthRedirectUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "NextCLI",
      client_uri: "https://nextcli.dev",
      redirect_uris: [this.redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...(this.serverUrl.includes("mcp.supabase.com") && {
        scope: SUPABASE_SCOPES,
      }),
    };
  }

  state(): string {
    this._state = randomUUID();
    return this._state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const entry = readStore()[this.serverUrl];
    if (!entry?.clientInformation) return undefined;
    // A client registered for a different callback URL (port changed) cannot
    // complete the redirect, so register again.
    if (entry.redirectUri && entry.redirectUri !== this.redirectUrl) {
      return undefined;
    }
    return entry.clientInformation;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    updateEntry(this.serverUrl, (entry) => ({
      ...entry,
      clientInformation,
      redirectUri: this.redirectUrl,
    }));
  }

  tokens(): OAuthTokens | undefined {
    const tokens = readStore()[this.serverUrl]?.tokens;
    if (!tokens) return undefined;
    const parsed = OAuthTokensSchema.safeParse(tokens);
    return parsed.success ? parsed.data : undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    updateEntry(this.serverUrl, (entry) => ({ ...entry, tokens }));
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error("No PKCE code verifier for this OAuth sign-in");
    }
    return this._codeVerifier;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier"): void {
    if (scope === "verifier") {
      this._codeVerifier = undefined;
      return;
    }
    if (scope === "all") {
      this._codeVerifier = undefined;
    }
    updateEntry(this.serverUrl, (entry) => {
      if (scope === "all") return undefined;
      if (scope === "client") {
        const { clientInformation: _c, redirectUri: _r, ...rest } = entry;
        return rest;
      }
      const { tokens: _t, ...rest } = entry;
      return rest;
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.options.interactive || !this._state) {
      // Headless: leave _pendingCode unset; the transport throws
      // UnauthorizedError and the caller reports that sign-in is required.
      return;
    }

    const { code } = await startAuthorizationCallback(this._state, {
      timeoutMs: this.options.timeoutMs,
    });
    this._pendingCode = code;

    this.options.onAuthorizationUrl?.(authorizationUrl);
    try {
      await (this.options.openBrowser ?? defaultOpenBrowser)(
        authorizationUrl.toString(),
      );
    } catch (error) {
      logger.warn("Could not open browser for MCP OAuth sign-in", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** True once a browser sign-in has started and is awaiting the redirect. */
  isAuthorizationPending(): boolean {
    return this._pendingCode !== undefined;
  }

  /** Wait for the authorization code from the browser redirect. */
  async waitForAuthorizationCode(): Promise<string> {
    if (!this._pendingCode) {
      throw new Error("No OAuth sign-in is in progress");
    }
    try {
      return await this._pendingCode;
    } finally {
      this._pendingCode = undefined;
    }
  }
}
