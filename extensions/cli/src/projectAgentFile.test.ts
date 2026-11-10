import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findProjectAgentFile } from "./projectAgentFile.js";

describe("findProjectAgentFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-agent-file-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when there is no agent file", () => {
    expect(findProjectAgentFile(dir)).toBeUndefined();
  });

  it("follows AGENTS.md, AGENT.md, CLAUDE.md, CODEX.md", () => {
    const names = ["AGENTS.md", "AGENT.md", "CLAUDE.md", "CODEX.md"];
    for (const name of names) {
      fs.writeFileSync(path.join(dir, name), name);
    }

    const found: string[] = [];
    for (const name of names) {
      found.push(path.basename(findProjectAgentFile(dir)!));
      fs.rmSync(path.join(dir, name));
    }

    expect(found).toEqual(names);
    expect(findProjectAgentFile(dir)).toBeUndefined();
  });
});
