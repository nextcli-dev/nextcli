import { createInitPrompt } from "@nextcli/config-yaml";
import { describe, expect, it } from "vitest";

import type { AssistantConfig } from "../services/types.js";

import { handleInit } from "./init.js";

describe("handleInit", () => {
  it("sends the shared agent file prompt as the next input", async () => {
    const result = await handleInit([], {} as AssistantConfig);

    expect(result.newInput).toBe(createInitPrompt());
    expect(result.exit).toBeUndefined();
  });

  it("only targets the project agent file", async () => {
    const result = await handleInit([], {} as AssistantConfig);

    expect(result.newInput).toContain("AGENTS.md");
    expect(result.newInput).not.toContain("review.md");
    expect(result.newInput).not.toContain(".continue/rules");
  });
});
