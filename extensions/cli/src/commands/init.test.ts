import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AssistantConfig } from "../services/types.js";

import { handleInit } from "./init.js";

describe("handleInit", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cn-init-")));
    vi.spyOn(process, "cwd").mockReturnValue(dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function initPrompt(): Promise<string> {
    const result = await handleInit([], {} as AssistantConfig);
    return result.newInput!;
  }

  it("creates AGENTS.md in the working directory with Write", async () => {
    const prompt = await initPrompt();

    expect(prompt).toContain(
      `Create \`${path.join(dir, "AGENTS.md")}\` with the \`Write\` tool`,
    );
    expect(prompt).toContain("loaded from the working directory");
    expect(prompt).toContain("rerun cn without --readonly");
    expect(prompt).not.toContain("review.md");
    expect(prompt).not.toContain("CONTINUE.md");
  });

  it("updates an existing CLAUDE.md with Edit instead of creating AGENTS.md", async () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Guide");

    const prompt = await initPrompt();

    expect(prompt).toContain(
      `The agent file for this project is \`${path.join(dir, "CLAUDE.md")}\``,
    );
    expect(prompt).toContain("change it with the `Edit` tool");
    expect(prompt).not.toContain("AGENTS.md");
  });

  it("merges and deletes a leftover CONTINUE.md", async () => {
    const legacy = path.join(dir, ".continue", "rules", "CONTINUE.md");
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.writeFileSync(legacy, "# Old guide");

    const prompt = await initPrompt();

    expect(prompt).toContain(
      `\`${legacy}\` was written by an older version of \`/init\``,
    );
    expect(prompt).toContain(`rm "${legacy}"`);
  });
});
