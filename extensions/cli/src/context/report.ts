import type { ContextSnapshot } from "@nextcli/context";
import chalk from "chalk";
import type { Usage } from "core/index.js";

import { services } from "../services/index.js";
import type { SlashCommandResult } from "../ui/hooks/useChat.types.js";
import { formatContextLength } from "../util/modelSettings.js";

import { getLastResponseUsage } from "./lastUsage.js";
import { cliContextSnapshot, nextRequestPrefix } from "./snapshot.js";

function count(tokens: number): string {
  return tokens.toLocaleString("en-US");
}

function rows(segments: ContextSnapshot["segments"], indent: string): string[] {
  const lines: string[] = [];
  for (const segment of segments) {
    lines.push(
      `${indent}${segment.label}  ${formatContextLength(segment.tokens)}  ${segment.source}`,
    );
    if (segment.children) {
      lines.push(...rows(segment.children, `${indent}  `));
    }
  }
  return lines;
}

function thresholdLine(snapshot: ContextSnapshot): string {
  const [first, ...rest] = snapshot.threshold.steps;
  const terms = [
    count(first?.tokens ?? snapshot.window),
    ...rest.map(
      (step) => `${count(Math.abs(step.tokens))} ${step.label}`,
    ),
  ];
  return `${terms.join(" − ")} = ${count(snapshot.threshold.tokens)}`;
}

function measuredLine(usage: Usage | undefined): string {
  if (!usage) {
    return "Measured: no provider usage for the last response";
  }
  const cached = usage.promptTokensDetails?.cachedTokens ?? 0;
  const written = usage.promptTokensDetails?.cacheWriteTokens ?? 0;
  const hit =
    usage.promptTokens > 0
      ? `${Math.round((cached / usage.promptTokens) * 100)}%`
      : "0%";
  return [
    "Measured",
    `prompt ${count(usage.promptTokens)}`,
    `output ${count(usage.completionTokens)}`,
    `cache read ${count(cached)}`,
    `cache write ${count(written)}`,
    `cache hit ${hit}`,
  ].join(" · ");
}

export function renderContextReport(
  snapshot: ContextSnapshot,
  usage: Usage | undefined,
): string {
  const lines = [
    chalk.bold(
      `Context ${formatContextLength(snapshot.used)} of ${formatContextLength(snapshot.window)}`,
    ),
    ...rows(snapshot.segments, ""),
    "",
    chalk.bold("Largest tool results"),
    ...(snapshot.largestToolResults.length > 0
      ? snapshot.largestToolResults.map(
          (result) =>
            `${result.label}  ${formatContextLength(result.tokens)}  estimated`,
        )
      : ["None"]),
    "",
    chalk.bold("Threshold"),
    thresholdLine(snapshot),
    "",
    measuredLine(usage),
  ];
  return lines.join("\n");
}

export async function handleContextSlashCommand(): Promise<SlashCommandResult> {
  if (services.systemMessage.getState().headless) {
    return {
      output:
        "Context breakdown is written to the trace when NEXTCLI_TRACE=basic.",
    };
  }
  const model = services.model.getState().model;
  if (!model) {
    return { output: "No model selected." };
  }
  const { systemMessage, tools } = await nextRequestPrefix(model);
  const snapshot = await cliContextSnapshot({
    model,
    chatHistory: services.chatHistory.getHistory(),
    systemMessage,
    tools,
  });
  return {
    output: renderContextReport(snapshot, getLastResponseUsage()),
  };
}
