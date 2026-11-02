import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAllMcpOAuthFlows,
  clearMcpOAuth,
  CliMcpOAuthProvider,
  getMcpOAuthRedirectUrl,
  getMcpOAuthStoragePath,
  hasStoredMcpOAuthTokens,
  isSafeAuthorizationUrl,
  setMcpOAuthLockTimeoutForTests,
  startAuthorizationCallback,
} from "./mcpOAuth.js";

const SERVER_URL = "https://mcp.example.com/mcp";

async function getFreePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function hitCallback(
  query: string,
  path = "/oauth/callback",
): Promise<{ status: number; body: string }> {
  const port = process.env.NEXTCLI_MCP_OAUTH_PORT;
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}?${query}`, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function isListening(): Promise<boolean> {
  return hitCallback("ping=1", "/nope").then(
    () => true,
    () => false,
  );
}

describe("mcpOAuth", () => {
  beforeEach(async () => {
    process.env.NEXTCLI_MCP_OAUTH_PORT = String(await getFreePort());
    fs.rmSync(getMcpOAuthStoragePath(), { force: true });
  });

  afterEach(() => {
    cancelAllMcpOAuthFlows();
    delete process.env.NEXTCLI_MCP_OAUTH_PORT;
    fs.rmSync(getMcpOAuthStoragePath(), { force: true });
    fs.rmSync(`${getMcpOAuthStoragePath()}.lock`, { force: true });
  });

  function bumpPort() {
    process.env.NEXTCLI_MCP_OAUTH_PORT = String(
      Number(process.env.NEXTCLI_MCP_OAUTH_PORT) + 1,
    );
  }

  describe("storage", () => {
    it("persists client information and tokens with 0600 permissions", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      provider.saveClientInformation({ client_id: "abc" });
      provider.saveTokens({ access_token: "tok", token_type: "Bearer" });

      const reloaded = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      expect(reloaded.clientInformation()).toEqual({ client_id: "abc" });
      expect(reloaded.tokens()).toMatchObject({ access_token: "tok" });
      expect(hasStoredMcpOAuthTokens(SERVER_URL)).toBe(true);
      expect(hasStoredMcpOAuthTokens("https://other.example.com")).toBe(false);

      if (process.platform !== "win32") {
        const mode = fs.statSync(getMcpOAuthStoragePath()).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    });

    it("ignores client information registered for another redirect URL", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      provider.saveClientInformation({ client_id: "abc" });
      process.env.NEXTCLI_MCP_OAUTH_PORT = String(
        Number(process.env.NEXTCLI_MCP_OAUTH_PORT) + 1,
      );
      expect(provider.clientInformation()).toBeUndefined();
    });

    it("keeps using the tokens' client for refresh after the port changes", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: false,
      });
      const interactive = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      interactive.saveClientInformation({ client_id: "abc" });
      interactive.clientInformation();
      interactive.saveTokens({
        access_token: "tok",
        token_type: "Bearer",
        refresh_token: "r",
      });

      bumpPort();
      expect(provider.clientInformation()).toEqual({ client_id: "abc" });
      expect(provider.tokens()).toMatchObject({ refresh_token: "r" });
    });

    it("keeps one client per redirect URL", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      provider.saveClientInformation({ client_id: "first" });
      bumpPort();
      expect(provider.clientInformation()).toBeUndefined();
      provider.saveClientInformation({ client_id: "second" });
      expect(provider.clientInformation()).toEqual({ client_id: "second" });
    });

    it("never registers a client in headless mode", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: false,
      });
      expect(() => provider.clientInformation()).toThrow(UnauthorizedError);
    });

    it("reads the older single-client layout", () => {
      const redirectUri = getMcpOAuthRedirectUrl();
      fs.mkdirSync(path.dirname(getMcpOAuthStoragePath()), {
        recursive: true,
      });
      fs.writeFileSync(
        getMcpOAuthStoragePath(),
        JSON.stringify({
          [SERVER_URL]: {
            clientInformation: { client_id: "old" },
            redirectUri,
            tokens: { access_token: "tok", token_type: "Bearer" },
          },
        }),
      );
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      expect(provider.clientInformation()).toEqual({ client_id: "old" });

      provider.saveTokens({ access_token: "new", token_type: "Bearer" });
      const stored = JSON.parse(
        fs.readFileSync(getMcpOAuthStoragePath(), "utf8"),
      )[SERVER_URL];
      expect(stored.clients).toEqual({ [redirectUri]: { client_id: "old" } });
      expect(stored.clientInformation).toBeUndefined();
    });

    it("moves a corrupt store aside instead of overwriting it", () => {
      const file = getMcpOAuthStoragePath();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{ not json");

      new CliMcpOAuthProvider(SERVER_URL, { interactive: true }).saveTokens({
        access_token: "tok",
        token_type: "Bearer",
      });

      const dir = path.dirname(file);
      const backups = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${path.basename(file)}.corrupt-`));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(dir, backups[0]), "utf8")).toBe(
        "{ not json",
      );
      for (const backup of backups) fs.rmSync(path.join(dir, backup));
      expect(hasStoredMcpOAuthTokens(SERVER_URL)).toBe(true);
    });

    it("waits for another process's lock and clears a stale one", () => {
      const lock = `${getMcpOAuthStoragePath()}.lock`;
      fs.mkdirSync(path.dirname(lock), { recursive: true });
      fs.writeFileSync(lock, "");
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });

      setMcpOAuthLockTimeoutForTests(50);
      try {
        expect(() =>
          provider.saveTokens({ access_token: "tok", token_type: "Bearer" }),
        ).toThrow(/Timed out waiting/);
        expect(hasStoredMcpOAuthTokens(SERVER_URL)).toBe(false);

        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, old, old);
        provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
        expect(hasStoredMcpOAuthTokens(SERVER_URL)).toBe(true);
        expect(fs.existsSync(lock)).toBe(false);
      } finally {
        setMcpOAuthLockTimeoutForTests(5_000);
      }
    });

    it("invalidates tokens, client, or everything", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      provider.saveClientInformation({ client_id: "abc" });
      provider.saveTokens({ access_token: "tok", token_type: "Bearer" });

      provider.invalidateCredentials("tokens");
      expect(provider.tokens()).toBeUndefined();
      expect(provider.clientInformation()).toEqual({ client_id: "abc" });

      provider.saveTokens({ access_token: "tok", token_type: "Bearer" });
      provider.invalidateCredentials("client");
      expect(provider.clientInformation()).toBeUndefined();
      expect(provider.tokens()).toBeDefined();

      provider.invalidateCredentials("all");
      expect(provider.tokens()).toBeUndefined();
    });

    it("clearMcpOAuth removes only that server", () => {
      new CliMcpOAuthProvider(SERVER_URL, { interactive: true }).saveTokens({
        access_token: "a",
        token_type: "Bearer",
      });
      new CliMcpOAuthProvider("https://other.example.com", {
        interactive: true,
      }).saveTokens({ access_token: "b", token_type: "Bearer" });

      clearMcpOAuth(SERVER_URL);
      expect(hasStoredMcpOAuthTokens(SERVER_URL)).toBe(false);
      expect(hasStoredMcpOAuthTokens("https://other.example.com")).toBe(true);
    });
  });

  describe("client metadata", () => {
    it("uses a loopback redirect and a public client", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      expect(provider.redirectUrl).toBe(getMcpOAuthRedirectUrl());
      expect(provider.redirectUrl).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/,
      );
      expect(provider.clientMetadata).toMatchObject({
        client_name: "NextCLI",
        redirect_uris: [provider.redirectUrl],
        token_endpoint_auth_method: "none",
      });
      expect(provider.clientMetadata.scope).toBeUndefined();
    });

    it("requests Supabase read scopes for the Supabase MCP server", () => {
      const provider = new CliMcpOAuthProvider("https://mcp.supabase.com/mcp", {
        interactive: true,
      });
      expect(provider.clientMetadata.scope).toContain("projects:read");
    });

    it("keeps the PKCE verifier in memory only", () => {
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      expect(() => provider.codeVerifier()).toThrow();
      provider.saveCodeVerifier("verifier");
      expect(provider.codeVerifier()).toBe("verifier");
      expect(fs.existsSync(getMcpOAuthStoragePath())).toBe(false);
    });
  });

  describe("callback listener", () => {
    it("resolves with the code for a matching state and then closes", async () => {
      const { code } = await startAuthorizationCallback("s1");
      const res = await hitCallback("code=abc&state=s1");
      expect(res.status).toBe(200);
      await expect(code).resolves.toBe("abc");
      expect(await isListening()).toBe(false);
    });

    it("rejects an unknown state without settling the pending flow", async () => {
      const { code } = await startAuthorizationCallback("s1");
      const res = await hitCallback("code=abc&state=wrong");
      expect(res.status).toBe(400);

      await hitCallback("code=good&state=s1");
      await expect(code).resolves.toBe("good");
    });

    it("rejects when the authorization server returns an error", async () => {
      const { code } = await startAuthorizationCallback("s1");
      await hitCallback("error=access_denied&error_description=nope&state=s1");
      await expect(code).rejects.toThrow(/access_denied.*nope/);
    });

    it("times out", async () => {
      const { code } = await startAuthorizationCallback("s1", {
        timeoutMs: 20,
      });
      await expect(code).rejects.toThrow(/Timed out/);
      expect(await isListening()).toBe(false);
    });

    it("reports a busy port clearly", async () => {
      const blocker = http.createServer();
      await new Promise<void>((resolve) =>
        blocker.listen(
          Number(process.env.NEXTCLI_MCP_OAUTH_PORT),
          "127.0.0.1",
          resolve,
        ),
      );
      try {
        await expect(startAuthorizationCallback("s1")).rejects.toThrow(
          /NEXTCLI_MCP_OAUTH_PORT/,
        );
      } finally {
        await new Promise<void>((resolve) => blocker.close(() => resolve()));
      }
    });
  });

  describe("redirectToAuthorization", () => {
    it("opens the browser and waits for the redirect when interactive", async () => {
      const openBrowser = vi.fn(async () => {});
      const onAuthorizationUrl = vi.fn();
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
        openBrowser,
        onAuthorizationUrl,
      });
      const state = provider.state();
      const authUrl = new URL("https://auth.example.com/authorize");

      await provider.redirectToAuthorization(authUrl);
      expect(openBrowser).toHaveBeenCalledWith(authUrl.toString());
      expect(onAuthorizationUrl).toHaveBeenCalledWith(authUrl);
      expect(provider.isAuthorizationPending()).toBe(true);

      await hitCallback(`code=xyz&state=${state}`);
      await expect(provider.waitForAuthorizationCode()).resolves.toBe("xyz");
      expect(provider.isAuthorizationPending()).toBe(false);
    });

    it("refuses authorization URLs that are not https", async () => {
      const openBrowser = vi.fn(async () => {});
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
        openBrowser,
      });
      provider.state();
      await expect(
        provider.redirectToAuthorization(new URL("file:///etc/passwd")),
      ).rejects.toThrow(/Refusing to open/);
      expect(openBrowser).not.toHaveBeenCalled();
      expect(provider.isAuthorizationPending()).toBe(false);
      expect(await isListening()).toBe(false);
    });

    it("asks to reconnect when the tokens' client has another callback URL", async () => {
      const openBrowser = vi.fn(async () => {});
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
        openBrowser,
      });
      provider.saveClientInformation({ client_id: "abc" });
      provider.saveTokens({ access_token: "t", token_type: "Bearer" });
      bumpPort();
      expect(provider.clientInformation()).toEqual({ client_id: "abc" });
      provider.state();

      await expect(
        provider.redirectToAuthorization(
          new URL("https://auth.example.com/authorize"),
        ),
      ).rejects.toThrow(/Reconnect to sign in again/);
      expect(openBrowser).not.toHaveBeenCalled();
      expect(provider.tokens()).toBeUndefined();
      expect(provider.clientInformation()).toBeUndefined();
    });

    it("does nothing when not interactive", async () => {
      const openBrowser = vi.fn(async () => {});
      const provider = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: false,
        openBrowser,
      });
      provider.state();
      await provider.redirectToAuthorization(
        new URL("https://auth.example.com/authorize"),
      );
      expect(openBrowser).not.toHaveBeenCalled();
      expect(provider.isAuthorizationPending()).toBe(false);
      expect(await isListening()).toBe(false);
    });
  });

  describe("isSafeAuthorizationUrl", () => {
    it.each([
      ["https://auth.example.com/authorize", true],
      ["http://localhost:8080/authorize", true],
      ["http://127.0.0.1/authorize", true],
      ["http://[::1]:9000/authorize", true],
      ["http://auth.example.com/authorize", false],
      ["file:///etc/passwd", false],
      ["vscode://evil/x", false],
      ["smb://host/share", false],
    ])("%s -> %s", (url, safe) => {
      expect(isSafeAuthorizationUrl(new URL(url))).toBe(safe);
    });
  });

  describe("startSignIn", () => {
    it("does nothing in headless mode or with stored tokens", async () => {
      const headless = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: false,
      });
      await expect(headless.startSignIn()).resolves.toBe(false);

      const signedIn = new CliMcpOAuthProvider(SERVER_URL, {
        interactive: true,
      });
      signedIn.saveTokens({ access_token: "t", token_type: "Bearer" });
      await expect(signedIn.startSignIn()).resolves.toBe(false);
    });

    it("returns false when the server has no OAuth metadata", async () => {
      const server = http.createServer((_req, res) => {
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const { port } = server.address() as AddressInfo;
      const openBrowser = vi.fn(async () => {});
      try {
        const provider = new CliMcpOAuthProvider(
          `http://127.0.0.1:${port}/mcp`,
          { interactive: true, openBrowser },
        );
        await expect(provider.startSignIn()).resolves.toBe(false);
        expect(openBrowser).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  });
});
