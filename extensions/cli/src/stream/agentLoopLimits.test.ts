import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUsage } from "../session.js";

import {
  checkAgentLoopLimits,
  configureAgentLoopLimits,
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
