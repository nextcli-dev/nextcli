import fs from "fs";
import http from "http";
import { AddressInfo } from "net";
import os from "os";
import path from "path";

import type { ModelConfig } from "@nextcli/config-yaml";
import type { ChatCompletionCreateParamsStreaming } from "openai/resources/index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../session.js", () => ({
  getCurrentSession: () => ({ sessionId: "s1" }),
}));
const warnBadEnv = vi.hoisted(() => vi.fn());

vi.mock("../util/logger.js", () => ({
  logger: {
    warn,
    getRunId: () => "r1",
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
  warnBadEnv,
}));

// NEXTCLI_TRACE=full: the same llm.request lines as basic, plus one JSON
// file per request a model adapter posts, under
// <traceDir>/<sessionId>-<runId>/, with credentials redacted. Off and basic
// compute nothing.
describe("request files (NEXTCLI_TRACE=full)", () => {
  let root: string;
  let dir: string;
  let server: http.Server;
  let apiBase: string;
  // What the provider received, and how it answers each request
  let received: { url: string; body: string }[];
  let answers: { status: number; headers?: Record<string, string> }[];
  let stopObserving: (() => void) | undefined;

  async function load(level?: string) {
    vi.resetModules();
    if (level === undefined) {
      delete process.env.NEXTCLI_TRACE;
    } else {
      process.env.NEXTCLI_TRACE = level;
    }
    process.env.NEXTCLI_TRACE_DIR = dir;
    const adapters = await import("@nextcli/openai-adapters");
    stopObserving = () => adapters.observeAdapterRequests(undefined);
    const { createLlmApi } = await import("../config.js");
    const trace = await import("./trace.js");
    return { createLlmApi, trace };
  }

  /** Sends one request through the model's adapter; the provider refuses it */
  async function send(
    createLlmApi: (typeof import("../config.js"))["createLlmApi"],
    model: Partial<ModelConfig>,
    body: Partial<ChatCompletionCreateParamsStreaming> &
      Record<string, unknown> = {},
  ) {
    const llmApi = createLlmApi(
      { name: "m", model: "m", provider: "openai", apiBase, ...model },
      {} as never,
    )!;
    const stream = llmApi.chatCompletionStream(
      {
        model: model.model ?? "m",
        stream: true,
        messages: [{ role: "user", content: "Review this PR text" }],
        ...body,
      },
      new AbortController().signal,
    );
    await expect(
      (async () => {
        for await (const _ of stream) {
          // the provider answers with an error
        }
      })(),
    ).rejects.toThrow();
  }

  const requestDir = () => path.join(dir, "s1-r1");
  const readRequest = (n: number) =>
    JSON.parse(
      fs.readFileSync(path.join(requestDir(), `request-${n}.json`), "utf-8"),
    );

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cn-trace-full-"));
    dir = path.join(root, "traces");
    warn.mockClear();
    warnBadEnv.mockClear();
    received = [];
    answers = [];
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        received.push({ url: req.url ?? "", body });
        const answer = answers.shift() ?? { status: 400 };
        res.writeHead(answer.status, {
          "content-type": "application/json",
          ...answer.headers,
        });
        res.end(JSON.stringify({ error: { message: "refused" } }));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
  });

  afterEach(async () => {
    stopObserving?.();
    await new Promise((resolve) => server.close(resolve));
    delete process.env.NEXTCLI_TRACE;
    delete process.env.NEXTCLI_TRACE_DIR;
    delete process.env.MY_API_KEY;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("writes nothing when unset", async () => {
    const { createLlmApi } = await load();

    await send(createLlmApi, {});

    expect(received).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("writes nothing for basic", async () => {
    const { createLlmApi } = await load("basic");

    await send(createLlmApi, {});

    expect(received).toHaveLength(1);
    expect(fs.existsSync(requestDir())).toBe(false);
  });

  it("writes the body Anthropic receives, in Anthropic's format", async () => {
    const { createLlmApi } = await load("full");

    await send(
      createLlmApi,
      { provider: "anthropic", model: "claude-sonnet-4-5", apiKey: "k" },
      {
        messages: [
          { role: "system", content: "You review pull requests." },
          { role: "user", content: "Review this PR text" },
        ],
        max_tokens: 100,
      },
    );

    expect(received).toHaveLength(1);
    const request = readRequest(1);
    expect(request.method).toBe("POST");
    expect(request.url).toBe(`${apiBase}messages`);
    expect(request.body).toEqual(JSON.parse(received[0].body));
    // The adapter's conversion: the system prompt moves out of the messages
    expect(JSON.stringify(request.body.system)).toContain(
      "You review pull requests.",
    );
    expect(
      request.body.messages.some(
        (message: { role: string }) => message.role === "system",
      ),
    ).toBe(false);
  });

  it("writes the body after the adapter rewrites it, extraBodyProperties included", async () => {
    const { createLlmApi } = await load("full");

    await send(
      createLlmApi,
      { requestOptions: { extraBodyProperties: { seed: 7 } } },
      { nextcli_fast: true },
    );

    const request = readRequest(1);
    expect(request.body).toEqual(JSON.parse(received[0].body));
    expect(request.body.seed).toBe(7);
    // OpenAI's adapter drops the controls meant for the Anthropic adapter
    expect(request.body).not.toHaveProperty("nextcli_fast");
  });

  it("writes one file per HTTP attempt, retries included", async () => {
    const { createLlmApi } = await load("full");
    answers = [{ status: 429, headers: { "retry-after-ms": "1" } }];

    await send(createLlmApi, {});

    expect(received).toHaveLength(2);
    expect(fs.readdirSync(requestDir()).sort()).toEqual([
      "request-1.json",
      "request-2.json",
    ]);
    expect(readRequest(2).body).toEqual(JSON.parse(received[1].body));
  });

  it("redacts every configured credential, however short", async () => {
    const { createLlmApi } = await load("full");
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIBclientkey\n";

    await send(
      createLlmApi,
      {
        apiKey: "sk-test",
        env: { SERVICE_TOKEN: 12345678901234, REGION: "eu-west-1" },
        requestOptions: {
          headers: { "X-Api-Key": "hdr-1", Authorization: "Bearer tok-2" },
          clientCertificate: {
            cert: "data:text/plain,cert",
            key: `data:text/plain;base64,${Buffer.from(pem).toString("base64")}`,
            passphrase: "pw-3",
          },
          extraBodyProperties: { service_token: 12345678901234 },
        },
      },
      {
        messages: [
          {
            role: "user",
            content:
              "keys: sk-test hdr-1 tok-2 pw-3 12345678901234 " +
              `${pem.trim()} region eu-west-1`,
          },
        ],
      },
    );

    const written = fs.readFileSync(
      path.join(requestDir(), "request-1.json"),
      "utf-8",
    );
    for (const secret of [
      "sk-test",
      "hdr-1",
      "tok-2",
      "pw-3",
      "12345678901234",
      "MIIBclientkey",
    ]) {
      expect(written).not.toContain(secret);
    }
    expect(JSON.parse(written).body.service_token).toBe("[redacted]");
    expect(written).toContain("region eu-west-1");
    // The provider got the request as configured
    expect(received[0].body).toContain("12345678901234");
  });

  it("redacts secret-like environment values wherever they appear", async () => {
    process.env.MY_API_KEY = "sk-env-secret-0123456789";
    const { createLlmApi } = await load("full");

    await send(
      createLlmApi,
      {},
      {
        messages: [
          {
            role: "user",
            content: "the key is sk-env-secret-0123456789, keep it safe",
          },
        ],
      },
    );

    const written = fs.readFileSync(
      path.join(requestDir(), "request-1.json"),
      "utf-8",
    );
    expect(written).not.toContain("sk-env-secret-0123456789");
    expect(written).toContain("the key is [redacted], keep it safe");
  });

  it.skipIf(process.platform === "win32")(
    "only the owner can read the files",
    async () => {
      const { createLlmApi } = await load("full");

      await send(createLlmApi, {});

      expect(fs.statSync(requestDir()).mode & 0o777).toBe(0o700);
      expect(
        fs.statSync(path.join(requestDir(), "request-1.json")).mode & 0o777,
      ).toBe(0o600);
    },
  );

  it("reads the level when a model is built, not at module load", async () => {
    const { createLlmApi } = await load();
    process.env.NEXTCLI_TRACE = "full";

    await send(createLlmApi, {});

    expect(fs.existsSync(path.join(requestDir(), "request-1.json"))).toBe(true);
  });

  it("stops after the first write that fails", async () => {
    // A file where the trace folder should be
    fs.writeFileSync(dir, "");
    const { createLlmApi } = await load("full");

    await send(createLlmApi, {});
    await send(createLlmApi, {});

    expect(received).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(fs.statSync(dir).isFile()).toBe(true);
  });
});
