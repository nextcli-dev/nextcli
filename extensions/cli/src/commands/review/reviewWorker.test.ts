import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { loadLocalAgentInstructions } from "./reviewWorker.js";

describe("loadLocalAgentInstructions", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A check file in a real folder */
  function check(content: string): string {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cn-check-"));
    const file = path.join(dir, "security-review.md");
    fs.writeFileSync(file, content);
    return file;
  }

  it("gives the model the instructions without the frontmatter", () => {
    // name and paths choose the check; they aren't instructions
    const file = check(
      '---\nname: Security Review\npaths:\n  - "core/**"\n---\n\nFlag secrets in the changed lines.',
    );

    expect(loadLocalAgentInstructions(file)).toBe(
      "Flag secrets in the changed lines.",
    );
  });

  it("keeps a file without frontmatter as it is", () => {
    expect(loadLocalAgentInstructions(check("Review the changed lines."))).toBe(
      "Review the changed lines.",
    );
  });
});
