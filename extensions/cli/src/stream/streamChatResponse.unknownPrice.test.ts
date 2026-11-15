import { afterEach, describe, expect, it, vi } from "vitest";

const stderr = vi.hoisted(() => [] as string[]);
vi.mock("../init.js", () => ({
  safeStderr: (message: string) => stderr.push(message),
}));

import {
  forgetUnknownPriceWarnings,
  warnUnknownZeroPrice,
} from "./streamChatResponse.helpers.js";

// The models.dev catalog lists Groq's allam-2-7b at $0: an unknown price
const allam = { provider: "groq", model: "allam-2-7b" };

describe("warnUnknownZeroPrice", () => {
  afterEach(() => {
    forgetUnknownPriceWarnings();
    stderr.length = 0;
  });

  it("warns in the chat once per model", () => {
    const onSystemMessage = vi.fn();
    warnUnknownZeroPrice(allam, false, { onSystemMessage });
    warnUnknownZeroPrice(allam, false, { onSystemMessage });

    expect(onSystemMessage).toHaveBeenCalledTimes(1);
    expect(onSystemMessage.mock.calls[0][0]).toMatch(
      /^Warning: .*allam-2-7b \(groq\) at \$0.*--max-cost still counts it/,
    );
    expect(stderr).toEqual([]);
  });

  it("warns on stderr in a headless run", () => {
    warnUnknownZeroPrice(allam, true);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]).toMatch(/^Warning: .*allam-2-7b/);
  });

  it("stays quiet for a priced model and OpenRouter's :free ids", () => {
    const onSystemMessage = vi.fn();
    warnUnknownZeroPrice(
      { provider: "groq", model: "openai/gpt-oss-120b" },
      false,
      { onSystemMessage },
    );
    warnUnknownZeroPrice(
      { provider: "openrouter", model: "google/gemma-4-31b-it:free" },
      true,
      { onSystemMessage },
    );
    expect(onSystemMessage).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
  });
});
