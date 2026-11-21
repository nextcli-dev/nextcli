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

  describe("project-relative paths", () => {
    // Claude Code rules write globs from the project root, while the
    // editor's current file, an @ mention or a Read result is an absolute URI
    const scoped = (sourceFile: string): RuleWithSource => ({
      name: "Source",
      rule: "Keep modules small",
      source: "rules-block",
      sourceFile,
      globs: ["src/**/*.ts"],
    });
    const names = (rule: RuleWithSource, paths: string[]) =>
      getApplicableRules(undefined, [rule], paths.map(fileItem)).map(
        (r) => r.name,
      );

    it.each([
      "file:///repo/.claude/rules/source.md",
      "file:///repo/.continue/rules/source.md",
    ])("match an absolute file URI in the project (%s)", (sourceFile) => {
      expect(names(scoped(sourceFile), ["file:///repo/src/app.ts"])).toEqual([
        "Source",
      ]);
      expect(names(scoped(sourceFile), ["file:///repo/lib/app.ts"])).toEqual(
        [],
      );
    });

    it("match a relative path from a code fence the same way", () => {
      expect(
        names(scoped("file:///repo/.claude/rules/source.md"), ["src/app.ts"]),
      ).toEqual(["Source"]);
    });

    it("decode an escaped project path", () => {
      expect(
        names(scoped("file:///my%20repo/.claude/rules/source.md"), [
          "file:///my%20repo/src/a%20b.ts",
        ]),
      ).toEqual(["Source"]);
    });
  });
});
