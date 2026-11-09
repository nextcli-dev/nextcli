import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AgentLoopBudget,
  AgentLoopLimitError,
  configureAgentLoopLimits,
  recordPriceSource,
  resetAgentLoopLimits,
} from "../stream/agentLoopLimits.js";
import {
  forgetCallEnds,
  recordCallEnd,
  resetCallEnd,
} from "../stream/turnContinuation.js";

import {
  assertHeadlessAnswer,
  EXIT_CODE_LIMIT_REACHED,
  exitHeadlessDone,
  exitHeadlessOnError,
  headlessExitCode,
  writeHeadlessError,
  writeHeadlessRunSummary,
} from "./headlessRunSummary.js";

const sessionUsage = { promptTokens: 0, completionTokens: 0, totalCost: 0 };
const stderr: string[] = [];

vi.mock("../init.js", () => ({
  safeStderr: vi.fn((message: string) => stderr.push(message)),
}));

const gracefulExit = vi.fn();
vi.mock("../util/exit.js", () => ({
  gracefulExit: (code: number) => gracefulExit(code),
}));

vi.mock("../session.js", () => ({
  getSessionUsage: vi.fn(() => ({ ...sessionUsage })),
}));

const start = { promptTokens: 100, completionTokens: 10, totalCost: 0.5 };

function summaryLine() {
  return JSON.parse(stderr.at(-1)!);
}

describe("writeHeadlessError", () => {
  beforeEach(() => {
    stderr.length = 0;
    Object.assign(sessionUsage, {
      promptTokens: 600,
      completionTokens: 60,
      totalCost: 0.6,
    });
  });

  afterEach(() => {
    resetAgentLoopLimits();
  });

  it("reports the error and what the run cost so far", () => {
    recordPriceSource("exact");
    writeHeadlessError(new Error("429 Too Many Requests"), start);

    expect(stderr).toHaveLength(1);
    expect(summaryLine()).toEqual({
      status: "error",
      message: "429 Too Many Requests",
      usage: {
        cost: 0.1,
        priced: "exact",
        promptTokens: 500,
        completionTokens: 50,
      },
    });
  });
});

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

describe("exitHeadlessOnError", () => {
  beforeEach(() => {
    stderr.length = 0;
    gracefulExit.mockClear();
    Object.assign(sessionUsage, {
      promptTokens: 300,
      completionTokens: 30,
      totalCost: 0.7,
    });
  });

  afterEach(() => {
    resetAgentLoopLimits();
  });

  it("writes an error line with usage and exits 1", async () => {
    await exitHeadlessOnError(new Error("socket hang up"), start, "json");

    expect(gracefulExit).toHaveBeenCalledWith(1);
    expect(summaryLine()).toMatchObject({
      status: "error",
      message: "socket hang up",
      usage: { promptTokens: 200, completionTokens: 20 },
    });
  });

  it("writes the limit summary and exits 3 at a limit", async () => {
    const error = new AgentLoopLimitError({
      limit: "cost",
      description: "cost limit of $1 (--max-cost)",
      stop: true,
    });

    await exitHeadlessOnError(error, start, "json");

    expect(gracefulExit).toHaveBeenCalledWith(EXIT_CODE_LIMIT_REACHED);
    expect(summaryLine().status).not.toBe("error");
  });
});

describe("exitHeadlessDone", () => {
  beforeEach(() => {
    stderr.length = 0;
    gracefulExit.mockClear();
  });

  afterEach(() => {
    resetAgentLoopLimits();
  });

  it("writes the done line and exits 0", async () => {
    await exitHeadlessDone(start, "json");

    expect(summaryLine().status).toBe("done");
    expect(gracefulExit).toHaveBeenCalledWith(0);
  });

  it("exits 3 when a limit ended the run", async () => {
    configureAgentLoopLimits({ maxTurns: "1" });
    new AgentLoopBudget().nextTurn();

    await exitHeadlessDone(start, "json");

    expect(summaryLine().status).toBe("limit");
    expect(gracefulExit).toHaveBeenCalledWith(EXIT_CODE_LIMIT_REACHED);
  });
});

describe("assertHeadlessAnswer", () => {
  afterEach(() => {
    forgetCallEnds();
  });

  it("names the output cap when the follow-up call stopped normally", () => {
    // The cut-off call, then the "write your final answer" call
    recordCallEnd({
      choices: [{ finish_reason: "length" }],
      usage: { completion_tokens: 4096 },
    });
    resetCallEnd();
    recordCallEnd({ choices: [{ finish_reason: "stop" }] });

    expect(() => assertHeadlessAnswer("", "json")).toThrow(
      "The model used all its output tokens (4096) before writing an answer.",
    );
  });

  it("names the output cap when the last call ran out of tokens", () => {
    recordCallEnd({
      choices: [{ finish_reason: "length" }],
      usage: { completion_tokens: 4096 },
    });

    expect(() => assertHeadlessAnswer("", "json")).toThrow(
      "The model used all its output tokens (4096) before writing an answer.",
    );
  });

  it("keeps the plain message when the last call stopped normally", () => {
    recordCallEnd({ choices: [{ finish_reason: "stop" }] });

    expect(() => assertHeadlessAnswer("", "json")).toThrow(
      "The model finished without writing an answer.",
    );
  });

  it("fails an empty answer under --format json", () => {
    expect(() => assertHeadlessAnswer("", "json")).toThrow(
      "The model finished without writing an answer.",
    );
    expect(() => assertHeadlessAnswer("  \n", "json")).toThrow();
  });

  it("accepts an answer under --format json", () => {
    expect(() =>
      assertHeadlessAnswer('{"verdict":"PASS"}', "json"),
    ).not.toThrow();
  });

  it("accepts an empty answer without --format json", () => {
    expect(() => assertHeadlessAnswer("")).not.toThrow();
  });
});
