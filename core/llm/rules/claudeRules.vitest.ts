import { describe, expect, it } from "vitest";
import { ContextItemId, ContextItemWithId, RuleWithSource } from "../..";
import { getApplicableRules } from "./getSystemMessageWithRules";

/** A file in the chat's context */
function fileItem(path: string): ContextItemWithId {
  return {
    id: { providerTitle: "file", itemId: path } as ContextItemId,
    uri: { type: "file", value: path },
    content: "",
    name: path,
    description: path,
  };
}

// .claude/rules sits at the workspace root, as .continue/rules does, so its
// rules aren't treated as rules for files under a nested directory
describe(".claude/rules rules", () => {
  const sourceFile = "/repo/.claude/rules/tests.md";

  it("apply to every request when they have no paths or globs", () => {
    const rule: RuleWithSource = {
      name: "Style",
      rule: "Write short functions",
      source: "rules-block",
      sourceFile,
    };

    const applicable = getApplicableRules(undefined, [rule], []);

    expect(applicable.map((r) => r.name)).toEqual(["Style"]);
  });

  it("apply to matching files anywhere in the workspace when scoped", () => {
    // paths: in Claude Code's frontmatter is read as globs
    const rule: RuleWithSource = {
      name: "Tests",
      rule: "Assert the behavior",
      source: "rules-block",
      sourceFile,
      globs: ["**/*.test.ts"],
    };

    expect(
      getApplicableRules(undefined, [rule], [fileItem("src/app.test.ts")]).map(
        (r) => r.name,
      ),
    ).toEqual(["Tests"]);
    expect(
      getApplicableRules(undefined, [rule], [fileItem("src/app.ts")]),
    ).toEqual([]);
  });
});
