import { RuleWithSource } from "core";
import { describe, expect, it } from "vitest";
import reducer, {
  carryOverLegacyRuleSettings,
  DEFAULT_UI_SLICE,
} from "./uiSlice";

const rule = (name: string, legacyName?: string): RuleWithSource => ({
  name,
  legacyName,
  rule: "",
  source: "colocated-markdown",
});

function carryOver(
  ruleSettings: Record<string, "on" | "off">,
  rules: RuleWithSource[],
) {
  return reducer(
    { ...DEFAULT_UI_SLICE, ruleSettings },
    carryOverLegacyRuleSettings(rules),
  ).ruleSettings;
}

describe("carryOverLegacyRuleSettings", () => {
  it("gives a renamed rule the setting saved under its old name", () => {
    expect(
      carryOver({ "vscode/rules.md": "off" }, [
        rule("extensions/vscode/rules.md", "vscode/rules.md"),
      ]),
    ).toEqual({
      "vscode/rules.md": "off",
      "extensions/vscode/rules.md": "off",
    });
  });

  it("keeps a setting already saved under the new name", () => {
    expect(
      carryOver(
        { "vscode/rules.md": "off", "extensions/vscode/rules.md": "on" },
        [rule("extensions/vscode/rules.md", "vscode/rules.md")],
      ),
    ).toEqual({
      "vscode/rules.md": "off",
      "extensions/vscode/rules.md": "on",
    });
  });

  it("gives every rule that shared the old name its setting", () => {
    expect(
      carryOver({ "gui/rules.md": "off" }, [
        rule("nextcli/gui/rules.md", "gui/rules.md"),
        rule("nextcli-log-flush/gui/rules.md", "gui/rules.md"),
      ]),
    ).toEqual({
      "gui/rules.md": "off",
      "nextcli/gui/rules.md": "off",
      "nextcli-log-flush/gui/rules.md": "off",
    });
  });

  it("leaves rules without an old name or saved setting alone", () => {
    expect(
      carryOver({}, [
        rule("gui/rules.md"),
        rule("extensions/vscode/rules.md", "vscode/rules.md"),
      ]),
    ).toEqual({});
  });
});
