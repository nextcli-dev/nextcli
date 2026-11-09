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

  it("resolves relative rule paths but not inline content", () => {
    const inline = "Always write tests\nfor new code";
    const result = resolveCliPathOptions(
      { rule: ["./rules/style.md", inline, "Be concise"] },
      cwd,
    );
    expect(result.rule).toEqual([
      path.resolve(cwd, "rules/style.md"),
      inline,
      "Be concise",
    ]);
  });

  it("handles undefined values", () => {
    expect(resolveCliPathOptions({}, cwd)).toEqual({
      config: undefined,
      rule: undefined,
    });
  });
});
