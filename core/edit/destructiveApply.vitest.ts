import { describe, expect, it } from "vitest";

import { DiffLine } from "..";
import { myersDiff } from "../diff/myers";
import { isLikelyDestructiveApply } from "./destructiveApply";

const ORIGINAL = `name: main-configuration
version: 1.0.0
schema: v1
models:
  - name: Opus 5.5
    provider: openai
    model: claude-opus-5-5
    roles:
      - chat
  - name: Sonnet 5.5
    provider: openai
    model: claude-sonnet-5-5`;

const RUNBOOK = `# NextCLI Ecosystem Operator Runbook

## 1. Release Targets & Automation
* Published via release-openai-adapters.yml.`;

const PROSE = `The user wants me to apply a suggested edit to the original code.
But the suggested edit is completely different content.
I think the correct response is to flag the mismatch.
The suggested edit appears to be a Markdown runbook.
Could you clarify what you intend? Options:
1. Replace the YAML file entirely with the runbook text.`;

function diff(oldText: string, newText: string): DiffLine[] {
  return myersDiff(oldText, newText);
}

describe("isLikelyDestructiveApply", () => {
  it("flags prose that replaced the file (the config.yaml incident)", () => {
    expect(isLikelyDestructiveApply(diff(ORIGINAL, PROSE), RUNBOOK)).toBe(true);
  });

  it("flags an emptied file when there was code to merge", () => {
    expect(isLikelyDestructiveApply(diff(ORIGINAL, ""), "model: x")).toBe(true);
  });

  it("allows a full rewrite that matches the suggested code", () => {
    expect(isLikelyDestructiveApply(diff(ORIGINAL, RUNBOOK), RUNBOOK)).toBe(
      false,
    );
  });

  it("allows an edit that keeps most of the original", () => {
    const edited = ORIGINAL.replace("claude-sonnet-5-5", "claude-sonnet-5-6");
    expect(
      isLikelyDestructiveApply(
        diff(ORIGINAL, edited),
        "model: claude-sonnet-5-6",
      ),
    ).toBe(false);
  });

  it("flags a partial snippet written out in place of the file", () => {
    const snippet = `models:
  # ... existing models ...
  - name: Haiku 5.5
    provider: openai
    model: claude-haiku-5-5`;
    expect(isLikelyDestructiveApply(diff(ORIGINAL, snippet), snippet)).toBe(
      true,
    );
  });

  it("allows a snippet merged into the file", () => {
    const snippet = `  # ... existing models ...
  - name: Haiku 5.5
    model: claude-haiku-5-5`;
    const merged = `${ORIGINAL}
  - name: Haiku 5.5
    model: claude-haiku-5-5`;
    expect(isLikelyDestructiveApply(diff(ORIGINAL, merged), snippet)).toBe(
      false,
    );
  });

  it("ignores very small originals", () => {
    expect(isLikelyDestructiveApply(diff("a\nb", PROSE), "x")).toBe(false);
  });
});
