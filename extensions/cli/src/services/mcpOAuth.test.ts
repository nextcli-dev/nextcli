import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cancelAllMcpOAuthFlows,
  clearMcpOAuth,
  CliMcpOAuthProvider,
  getMcpOAuthRedirectUrl,
  getMcpOAuthStoragePath,
  hasStoredMcpOAuthTokens,
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
  });

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
});
