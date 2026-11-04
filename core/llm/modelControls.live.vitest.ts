/**
 * Live checks of the model menu settings against the real provider APIs,
 * for the providers NextCli fully supports. Run before each release:
 *
 *   cd core && NEXTCLI_LIVE=1 npx vitest run llm/modelControls.live.vitest.ts
 *
 * Skipped unless NEXTCLI_LIVE=1, so CI stays offline. Keys come from the
 * environment, then from ~/.continue/.env. A provider without credentials
 * is skipped and named in the test title; it doesn't count as passing.
 *
 * For every model, the cases come from the menu's own getModelControls():
 * each thinking mode, each effort level and fast mode it offers must be
 * accepted by the API, Off must return no thinking text, Hidden must return
 * none, and Shown must return some.
 */
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { describe, expect, test } from "vitest";

import type { ILLM } from "../index.js";
import Anthropic from "./llms/Anthropic.js";
import Azure from "./llms/Azure.js";
import Bedrock from "./llms/Bedrock.js";
import Gemini from "./llms/Gemini.js";
import Ollama from "./llms/Ollama.js";
import OpenAI from "./llms/OpenAI.js";
import OpenRouter from "./llms/OpenRouter.js";

const LIVE = process.env.NEXTCLI_LIVE === "1";
const REQUEST_TIMEOUT = 180_000;

/** A multi-step question, so models that can think do */
const THINKING_PROMPT =
  "A farmer has chickens and cows: 30 heads and 74 legs. He buys 5 cows and sells 3 chickens. How many legs now? One line.";
/** A cheap prompt for checks that only need the request to be accepted */
const SHORT_PROMPT = "Reply with the word ok.";

function readDotEnv(): Record<string, string> {
  const file = path.join(os.homedir(), ".continue", ".env");
  if (!fs.existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0 || line.trimStart().startsWith("#")) continue;
    values[line.slice(0, index).trim()] = line
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return values;
}

const dotEnv = LIVE ? readDotEnv() : {};
function env(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name] ?? dotEnv[name];
    if (value) return value;
  }
  return undefined;
}

interface Target {
  provider: string;
  /** Why the provider is skipped, or undefined when it can run */
  missing?: string;
  models: () => ILLM[];
}

/** Installed Ollama models, or undefined when Ollama isn't running */
function ollamaModels(): string[] | undefined {
  // Checked synchronously at collection time, so the test titles say why
  const result = spawnSync(
    "curl",
    ["-s", "--max-time", "2", "http://localhost:11434/api/tags"],
    { encoding: "utf8" },
  );
  if (result.status !== 0) return undefined;
  try {
    return JSON.parse(result.stdout).models.map(
      (m: { name: string }) => m.name,
    );
  } catch {
    return undefined;
  }
}

const OLLAMA_REASONING =
  /qwen3|deepseek-r1|gpt-oss|magistral|qwq|phi4-reasoning/;
const ollamaInstalled = LIVE ? ollamaModels() : [];
const ollamaModel =
  env("NEXTCLI_LIVE_OLLAMA_MODEL") ??
  ollamaInstalled?.find((name) => OLLAMA_REASONING.test(name));

function ollamaMissing(): string | undefined {
  if (!LIVE || ollamaModel) return undefined;
  return ollamaInstalled
    ? "pull a reasoning model, for example `ollama pull qwen3:8b`"
    : "start Ollama on :11434";
}

const awsCredentials =
  !!env("AWS_ACCESS_KEY_ID") ||
  !!env("AWS_PROFILE") ||
  fs.existsSync(path.join(os.homedir(), ".aws", "credentials"));

const TARGETS: Target[] = [
  {
    provider: "Anthropic",
    missing: env("ANTHROPIC_API_KEY") ? undefined : "set ANTHROPIC_API_KEY",
    models: () =>
      [env("NEXTCLI_LIVE_ANTHROPIC_MODEL") ?? "claude-sonnet-5-5"].map(
        (model) => new Anthropic({ model, apiKey: env("ANTHROPIC_API_KEY") }),
      ),
  },
  {
    provider: "OpenAI",
    missing: env("OPENAI_API_KEY", "OPEN_API_KEY")
      ? undefined
      : "set OPENAI_API_KEY",
    models: () =>
      ["gpt-5.5", "gpt-5"].map(
        (model) =>
          new OpenAI({ model, apiKey: env("OPENAI_API_KEY", "OPEN_API_KEY") }),
      ),
  },
  {
    provider: "OpenRouter",
    missing: env("OPENROUTER_API_KEY") ? undefined : "set OPENROUTER_API_KEY",
    models: () =>
      ["anthropic/claude-haiku-5.5", "google/gemini-3.5-flash"].map(
        (model) => new OpenRouter({ model, apiKey: env("OPENROUTER_API_KEY") }),
      ),
  },
  {
    provider: "Gemini",
    missing: env("GEMINI_API_KEY", "PROFILE_GEMINI_API_KEY")
      ? undefined
      : "set GEMINI_API_KEY",
    models: () =>
      [env("NEXTCLI_LIVE_GEMINI_MODEL") ?? "gemini-3.5-flash"].map(
        (model) =>
          new Gemini({
            model,
            apiKey: env("GEMINI_API_KEY", "PROFILE_GEMINI_API_KEY"),
          }),
      ),
  },
  {
    provider: "Bedrock",
    missing: awsCredentials
      ? undefined
      : "set AWS_ACCESS_KEY_ID or AWS_PROFILE, or add ~/.aws/credentials",
    models: () => [
      new Bedrock({
        model:
          env("NEXTCLI_LIVE_BEDROCK_MODEL") ??
          "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        region: env("AWS_REGION") ?? "us-east-1",
        profile: env("AWS_PROFILE"),
        accessKeyId: env("AWS_ACCESS_KEY_ID"),
        secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
      } as any),
    ],
  },
  {
    provider: "Azure",
    missing:
      env("AZURE_OPENAI_API_KEY") &&
      env("AZURE_OPENAI_ENDPOINT") &&
      env("AZURE_OPENAI_DEPLOYMENT")
        ? undefined
        : "set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT",
    models: () => [
      new Azure({
        model: env("AZURE_OPENAI_MODEL") ?? "gpt-5.5",
        apiKey: env("AZURE_OPENAI_API_KEY"),
        apiBase: env("AZURE_OPENAI_ENDPOINT"),
        deployment: env("AZURE_OPENAI_DEPLOYMENT"),
        apiVersion: env("AZURE_OPENAI_API_VERSION") ?? "2025-04-01-preview",
      }),
    ],
  },
  {
    provider: "Ollama",
    missing: ollamaMissing(),
    models: () => [new Ollama({ model: ollamaModel ?? "qwen3:8b" })],
  },
];

interface Reply {
  thinking: string;
  content: string;
}

async function ask(
  llm: ILLM,
  prompt: string,
  options: Record<string, unknown>,
): Promise<Reply> {
  let thinking = "";
  let content = "";
  const gen = llm.streamChat(
    [{ role: "user", content: prompt }],
    new AbortController().signal,
    { maxTokens: 4000, ...options },
  );
  let next = await gen.next();
  while (!next.done) {
    const message = next.value;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part: any) => part.text ?? "").join("");
    if (message.role === "thinking") thinking += text;
    else content += text;
    next = await gen.next();
  }
  return { thinking, content };
}

const CREDENTIAL_ERROR =
  /api key not valid|invalid api key|incorrect api key|security token|unauthori[sz]ed|authentication|permission denied|\b40[13]\b/i;

/** The readable part of a provider error, without the JSON around it */
function shortError(error: unknown): string {
  // Provider errors often nest JSON in JSON; keep the innermost message
  const text = String((error as Error)?.message ?? error)
    .replace(/\\[nrt]/g, " ")
    .replace(/[\\"{}[\]]/g, " ");
  const messages = [...text.matchAll(/message\s*:\s*([^,:]+?)\s*,/g)];
  return (messages.at(-1)?.[1] ?? text)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

describe.skipIf(!LIVE)("live model menu settings", () => {
  for (const target of TARGETS) {
    if (target.missing) {
      describe(`${target.provider} (skipped: ${target.missing})`, () => {
        test.skip("needs credentials", () => {});
      });
      continue;
    }

    for (const llm of target.models()) {
      const controls = llm.getModelControls();
      describe(`${target.provider} ${llm.model}`, () => {
        // When the provider rejects the credentials, this test fails once
        // with the reason and the rest of the model's tests are skipped
        let rejected: string | undefined;
        const check = (name: string, run: () => Promise<void>): void => {
          test(
            name,
            async (context) => {
              if (rejected) context.skip();
              await run();
            },
            REQUEST_TIMEOUT,
          );
        };

        test(
          "credentials are accepted and the model answers",
          async () => {
            try {
              const reply = await ask(llm, SHORT_PROMPT, {});
              expect(reply.content.trim()).not.toBe("");
            } catch (error) {
              if (CREDENTIAL_ERROR.test(String((error as Error)?.message))) {
                rejected = shortError(error);
                throw new Error(
                  `${target.provider} rejected the credentials: ${rejected}`,
                );
              }
              throw error;
            }
          },
          REQUEST_TIMEOUT,
        );

        for (const mode of controls.thinkingModes) {
          check(`thinking ${mode}`, async () => {
            const reply = await ask(llm, THINKING_PROMPT, { thinking: mode });
            expect(reply.content.trim()).not.toBe("");
            if (mode === "shown") {
              expect(reply.thinking.length).toBeGreaterThan(0);
            } else {
              // Off returns no reasoning, Hidden asks the API not to
              expect(reply.thinking).toBe("");
            }
          });
        }

        for (const effort of controls.efforts) {
          check(`effort ${effort} is accepted`, async () => {
            const reply = await ask(llm, SHORT_PROMPT, {
              reasoningEffort: effort,
              // Effort applies only while the model thinks
              ...(controls.thinkingModes.includes("shown") && {
                thinking: "shown",
              }),
            });
            expect(reply.content.trim()).not.toBe("");
          });
        }

        if (controls.fast) {
          check("fast mode is accepted", async () => {
            const reply = await ask(llm, SHORT_PROMPT, { fast: true });
            expect(reply.content.trim()).not.toBe("");
          });
        }
      });
    }
  }
});
