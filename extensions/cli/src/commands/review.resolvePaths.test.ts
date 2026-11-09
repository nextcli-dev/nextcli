import fs from "fs";
import os from "os";
import path from "path";

import { resolveCliPathOptions } from "./review.js";

describe("resolveCliPathOptions", () => {
  const cwd = path.resolve("/work/repo");

  it("resolves relative config paths against cwd", () => {
    expect(resolveCliPathOptions({ config: "./c.yaml" }, cwd).config).toBe(
      path.resolve(cwd, "c.yaml"),
    );
    expect(
      resolveCliPathOptions({ config: "../shared/c.yml" }, cwd).config,
    ).toBe(path.resolve("/work/shared/c.yml"));
  });

  it("leaves absolute paths, slugs and ~ paths unchanged", () => {
    const abs = path.resolve("/etc/c.yaml");
    expect(resolveCliPathOptions({ config: abs }, cwd).config).toBe(abs);
    expect(
      resolveCliPathOptions({ config: "owner/assistant" }, cwd).config,
    ).toBe("owner/assistant");
    expect(resolveCliPathOptions({ config: "~/c.yaml" }, cwd).config).toBe(
      "~/c.yaml",
    );
  });

  it("resolves relative rule paths that exist but not inline content", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cn-review-rules-"));
    try {
      fs.mkdirSync(path.join(repo, "rules"));
      fs.writeFileSync(path.join(repo, "rules", "style.md"), "Be terse");
      const inline = "Always write tests\nfor new code";
      const result = resolveCliPathOptions(
        { rule: ["./rules/style.md", "rules/style.md", inline, "Be concise"] },
        repo,
      );
      expect(result.rule).toEqual([
        path.join(repo, "rules", "style.md"),
        path.join(repo, "rules", "style.md"),
        inline,
        "Be concise",
      ]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("leaves inline rule content that looks like a path unchanged", () => {
    const rules = [
      "Avoid default exports in index.js",
      "Node.js",
      "./missing-rule.md",
    ];
    expect(resolveCliPathOptions({ rule: rules }, cwd).rule).toEqual(rules);
  });

  it("leaves ~ and file:// rule paths for downstream decoding", () => {
    const rules = ["~/rules/style.md", "file:///tmp/style.md"];
    expect(resolveCliPathOptions({ rule: rules }, cwd).rule).toEqual(rules);
  });

  it("leaves file:// config URLs unchanged", () => {
    expect(
      resolveCliPathOptions({ config: "file:///abs/config.yaml" }, cwd).config,
    ).toBe("file:///abs/config.yaml");
  });

  it("handles undefined values", () => {
    expect(resolveCliPathOptions({}, cwd)).toEqual({
      config: undefined,
      rule: undefined,
    });
  });
});
