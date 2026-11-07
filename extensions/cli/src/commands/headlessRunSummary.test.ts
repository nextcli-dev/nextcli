import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentLoopBudget,
  AgentLoopLimitError,
  configureAgentLoopLimits,
  recordPriceSource,
  resetAgentLoopLimits,
} from "../stream/agentLoopLimits.js";

import {
  EXIT_CODE_LIMIT_REACHED,
  headlessExitCode,
  writeHeadlessRunSummary,
} from "./headlessRunSummary.js";

const sessionUsage = { promptTokens: 0, completionTokens: 0, totalCost: 0 };
const stderr: string[] = [];

vi.mock("../init.js", () => ({
  safeStderr: vi.fn((message: string) => stderr.push(message)),
}));

vi.mock("../session.js", () => ({
  getSessionUsage: vi.fn(() => ({ ...sessionUsage })),
}));

const start = { promptTokens: 100, completionTokens: 10, totalCost: 0.5 };

function summaryLine() {
  return JSON.parse(stderr.at(-1)!);
}

describe("writeHeadlessRunSummary", () => {
  beforeEach(() => {
    stderr.length = 0;
    Object.assign(sessionUsage, {
      promptTokens: 1100,
      completionTokens: 210,
      totalCost: 0.75,
    });
  });

  afterEach(() => {
    resetAgentLoopLimits();
  });

  it("reports this run's usage as one JSON line", () => {
    recordPriceSource("exact");
    writeHeadlessRunSummary(start, "json");

    expect(stderr).toHaveLength(1);
    expect(summaryLine()).toEqual({
      status: "done",
      limit: null,
      usage: {
        cost: 0.25,
        priced: "exact",
        promptTokens: 1000,
        completionTokens: 200,
      },
    });
  });

  it("reports the limit that ended the run", () => {
    configureAgentLoopLimits({ maxTurns: "1" });
    new AgentLoopBudget().nextTurn();
    writeHeadlessRunSummary(start, "json");

    expect(summaryLine()).toMatchObject({ status: "limit", limit: "turns" });
  });

  it("keeps the least exact price source", () => {
    recordPriceSource("exact");
    recordPriceSource("fallback");
    recordPriceSource("estimated");
    writeHeadlessRunSummary(start, "json");

    expect(summaryLine().usage.priced).toBe("fallback");
  });

  it("warns when a cost limit uses an estimated price", () => {
    configureAgentLoopLimits({ maxCost: "1" });
    recordPriceSource("estimated");
    writeHeadlessRunSummary(start, "json");

    expect(stderr[0]).toMatch(/--max-cost limit of \$1 .*estimated cost/);
    expect(summaryLine().usage.priced).toBe("estimated");
  });

  it("writes only the warning without --format json", () => {
    configureAgentLoopLimits({ maxCost: "1" });
    recordPriceSource("fallback");
    writeHeadlessRunSummary(start);

    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^Warning:/);
  });

  it("writes nothing without --format json when prices are exact", () => {
    configureAgentLoopLimits({ maxCost: "1" });
    recordPriceSource("exact");
    writeHeadlessRunSummary(start);

    expect(stderr).toHaveLength(0);
  });

  it("exits 3 and writes the usage line when a limit ended the run", () => {
    configureAgentLoopLimits({ maxTurns: "1", maxCost: "1" });
    recordPriceSource("exact");
    new AgentLoopBudget().nextTurn();

    const error = new Error("wrap-up request failed");
    expect(headlessExitCode(error)).toBe(EXIT_CODE_LIMIT_REACHED);
    writeHeadlessRunSummary(start, "json");

    expect(summaryLine()).toMatchObject({
      status: "limit",
      limit: "turns",
      usage: { priced: "exact", cost: 0.25 },
    });
  });

  it("exits 3 for a hard stop before the wrap-up call", () => {
    const error = new AgentLoopLimitError({
      limit: "cost",
      description: "cost limit of $1 (--max-cost)",
      stop: true,
    });

    expect(headlessExitCode(error)).toBe(EXIT_CODE_LIMIT_REACHED);
  });

  it("exits 1 for an unrelated failure", () => {
    expect(headlessExitCode(new Error("boom"))).toBe(1);
    expect(headlessExitCode()).toBe(0);
  });
});
