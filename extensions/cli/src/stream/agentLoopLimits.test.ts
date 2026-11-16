import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUsage } from "../session.js";

import {
  AgentLoopBudget,
  checkAgentLoopLimits,
  configureAgentLoopLimits,
  getAgentLoopLimits,
  getLimitReached,
  resetAgentLoopLimits,
} from "./agentLoopLimits.js";
import {
  estimateFinalCallCost,
  FINAL_ANSWER_TOKENS,
  FINAL_PROMPT_GROWTH,
  finalAnswerMaxTokens,
} from "./streamChatResponse.helpers.js";

vi.mock("../session.js", () => ({ getSessionUsage: vi.fn() }));

// oneprovider charges $1.32 per million input tokens and $3.96 per million
// output tokens for deepseek-v4-pro. A reasoning model: it spends output
// tokens thinking before it writes any answer.
const deepseek = {
  provider: "openai",
  model: "deepseek-v4-pro",
  apiBase: "https://api.oneprovider.dev/v1",
  defaultCompletionOptions: { maxTokens: 64_000 },
};

function spend(cost: number) {
  vi.mocked(getSessionUsage).mockReturnValue({
    promptTokens: 0,
    completionTokens: 0,
    totalCost: cost,
  } as any);
}

describe("the --max-cost reserve", () => {
  beforeEach(() => {
    resetAgentLoopLimits();
    configureAgentLoopLimits({ maxCost: "0.30" } as any);
  });

  it("asks for the final answer while it can still be paid for", () => {
    // The numbers of a real review that came back with no answer: the last
    // call cost $0.05 and the history was 45k tokens. The call after it adds
    // tool results, so the final prompt is bigger than the history now.
    const lastCall = { tokens: 40_000, cost: 0.05 };
    const finalCall = () => estimateFinalCallCost(deepseek, 45_000);

    // $0.15 left. One more call like the last one leaves $0.10, but by then
    // the final prompt costs about $0.07 and a full-size answer on top of it
    // another $0.06. The old reserve (the final call alone, about $0.14) let
    // that call go ahead.
    spend(0.15);
    const wrapUp = checkAgentLoopLimits(
      { maxTurns: 100, maxIdenticalToolCalls: 2, maxCostUsd: 0.3 },
      12,
      { tokens: 0, cost: 0 },
      lastCall,
      finalCall,
    );

    expect(wrapUp).toMatchObject({ limit: "cost" });
    expect(wrapUp?.stop).toBeUndefined();
  });

  it("leaves the final call enough money for a full answer", () => {
    // A call is made just above the reserve. After it, what is left has to
    // pay for the final prompt (which that call grew) and a full-size answer.
    // A reasoning model that is squeezed into a few thousand tokens spends
    // them all thinking and returns nothing.
    const grownPrompt = Math.ceil(45_000 * FINAL_PROMPT_GROWTH);
    const finalCall = estimateFinalCallCost(deepseek, 45_000);

    expect(finalAnswerMaxTokens(deepseek, finalCall + 1e-6, grownPrompt)).toBe(
      FINAL_ANSWER_TOKENS,
    );
  });

  it("lets a cheap run continue", () => {
    const lastCall = { tokens: 2000, cost: 0.003 };
    spend(0.02);
    expect(
      checkAgentLoopLimits(
        { maxTurns: 100, maxIdenticalToolCalls: 2, maxCostUsd: 0.3 },
        3,
        { tokens: 0, cost: 0 },
        lastCall,
        () => estimateFinalCallCost(deepseek, 5_000),
      ),
    ).toBeUndefined();
  });

  it("stops without another call once the limit is passed", () => {
    spend(0.31);
    expect(
      checkAgentLoopLimits(
        { maxTurns: 100, maxIdenticalToolCalls: 2, maxCostUsd: 0.3 },
        20,
        { tokens: 0, cost: 0 },
        { tokens: 1000, cost: 0.01 },
        () => 0.01,
      ),
    ).toMatchObject({ limit: "cost", stop: true });
  });
});

describe("--max-time", () => {
  // When the limits were set, in milliseconds since the epoch
  let setAt: number;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    resetAgentLoopLimits();
    setAt = Date.now();
    configureAgentLoopLimits({ maxTime: "1000" });
  });

  afterEach(() => {
    vi.useRealTimers();
    resetAgentLoopLimits();
  });

  /** The time this many seconds after the limits were set */
  const after = (seconds: number) => setAt + seconds * 1000;

  /**
   * What the next turn of a run gets, when the run starts `start` seconds
   * after the limits were set and its turns take these many seconds
   */
  function nextTurnAfter(start: number, ...turnSeconds: number[]) {
    let elapsed = start;
    vi.setSystemTime(after(elapsed));
    const budget = new AgentLoopBudget();
    let wrapUp = budget.nextTurn();
    for (const seconds of turnSeconds) {
      elapsed += seconds;
      vi.setSystemTime(after(elapsed));
      wrapUp = budget.nextTurn();
    }
    return wrapUp;
  }

  it("counts from when the limits are set", () => {
    expect(getAgentLoopLimits()).toMatchObject({
      maxSeconds: 1000,
      deadline: after(1000),
    });
  });

  it("goes on while the time left covers a turn like the last and the answer", () => {
    // 300 left: a 150-second turn and the 100 seconds kept for the answer
    expect(nextTurnAfter(550, 150)).toBeUndefined();
  });

  it("wraps up when it doesn't", () => {
    // 300 left: less than a 250-second turn and the 100 kept
    expect(nextTurnAfter(450, 250)).toEqual({
      limit: "time",
      description: "time limit of 1000 seconds (--max-time)",
    });
    expect(getLimitReached()).toBe("time");
  });

  it("keeps only the tenth for the answer before the first turn", () => {
    expect(nextTurnAfter(899)).toBeUndefined();
    expect(nextTurnAfter(901)).toMatchObject({ limit: "time" });
  });

  it("still makes the final call past the deadline", () => {
    const wrapUp = nextTurnAfter(1190, 10);
    expect(wrapUp).toMatchObject({ limit: "time" });
    expect(wrapUp).not.toHaveProperty("stop");
  });

  it("is off without the flag", () => {
    resetAgentLoopLimits();
    configureAgentLoopLimits({});
    expect(nextTurnAfter(1e6, 500)).toBeUndefined();
  });

  it("rejects a time that isn't a positive number", () => {
    expect(() => configureAgentLoopLimits({ maxTime: "soon" })).toThrow(
      /--max-time/,
    );
  });

  it("times each turn of a run from one call to the next", () => {
    // 200 left after two 400-second turns: less than 400 plus the 100 kept
    expect(nextTurnAfter(0, 400)).toBeUndefined();
    expect(nextTurnAfter(0, 400, 400)).toMatchObject({ limit: "time" });
  });

  it("doesn't time a compaction's call", () => {
    vi.setSystemTime(after(950));
    expect(new AgentLoopBudget(undefined, false).nextTurn()).toBeUndefined();
  });
});
