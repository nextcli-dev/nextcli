import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSessionUsage } from "../session.js";

import {
  checkAgentLoopLimits,
  configureAgentLoopLimits,
  resetAgentLoopLimits,
} from "./agentLoopLimits.js";
import {
  estimateFinalAnswerCost,
  FINAL_PROMPT_GROWTH,
  finalAnswerMaxTokens,
  guaranteedFinalAnswerTokens,
  MIN_FINAL_ANSWER_TOKENS,
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
    const finalCall = () =>
      estimateFinalAnswerCost(
        deepseek,
        Math.ceil(45_000 * FINAL_PROMPT_GROWTH),
        guaranteedFinalAnswerTokens(deepseek),
      );

    // $0.11 left. One more call like the last one would leave $0.06, and the
    // final prompt alone costs about $0.07, so there'd be no room to answer.
    spend(0.19);
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
    // pay for the final prompt (which that call grew) and the guaranteed
    // output, so the final answer is not squeezed into a few tokens.
    const grownPrompt = Math.ceil(45_000 * FINAL_PROMPT_GROWTH);
    const finalCall = estimateFinalAnswerCost(
      deepseek,
      grownPrompt,
      guaranteedFinalAnswerTokens(deepseek),
    );

    const maxTokens = finalAnswerMaxTokens(
      deepseek,
      finalCall + 1e-6,
      grownPrompt,
    );
    expect(maxTokens).toBeGreaterThanOrEqual(MIN_FINAL_ANSWER_TOKENS);
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
        () =>
          estimateFinalAnswerCost(
            deepseek,
            Math.ceil(5_000 * FINAL_PROMPT_GROWTH),
            guaranteedFinalAnswerTokens(deepseek),
          ),
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
