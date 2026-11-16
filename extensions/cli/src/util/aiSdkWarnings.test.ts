import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./logger.js", () => ({ logger: { debug: vi.fn() } }));

import { routeAiSdkWarningsToLog } from "./aiSdkWarnings.js";
import { logger } from "./logger.js";

const scope = globalThis as { AI_SDK_LOG_WARNINGS?: any };

afterEach(() => {
  delete scope.AI_SDK_LOG_WARNINGS;
  vi.mocked(logger.debug).mockClear();
});

describe("routeAiSdkWarningsToLog", () => {
  it("sends AI SDK warnings to the debug log, not to stderr", () => {
    const emitWarning = vi.spyOn(process, "emitWarning");
    routeAiSdkWarningsToLog();

    const warning = {
      type: "unsupported",
      feature: "temperature",
      details: "temperature is not supported when thinking is enabled",
    };
    scope.AI_SDK_LOG_WARNINGS({
      warnings: [warning],
      provider: "anthropic.messages",
      model: "claude-sonnet-5-5",
    });

    expect(logger.debug).toHaveBeenCalledWith("AI SDK warning", {
      provider: "anthropic.messages",
      model: "claude-sonnet-5-5",
      warning,
    });
    expect(emitWarning).not.toHaveBeenCalled();
    emitWarning.mockRestore();
  });

  it("keeps a hook that is already set", () => {
    const mine = vi.fn();
    scope.AI_SDK_LOG_WARNINGS = mine;
    routeAiSdkWarningsToLog();
    expect(scope.AI_SDK_LOG_WARNINGS).toBe(mine);
  });
});
