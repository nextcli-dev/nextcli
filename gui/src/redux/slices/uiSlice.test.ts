import { RuleWithSource } from "core";
import { describe, expect, it } from "vitest";
import reducer, {
  addTrustedCommands,
  addTrustedFetchHost,
  carryOverLegacyRuleSettings,
  DEFAULT_UI_SLICE,
  removeTrustedCommand,
  removeTrustedFetchHost,
} from "./uiSlice";

describe("trusted commands", () => {
  it("starts empty, so every command the evaluator doesn't approve asks", () => {
    expect(DEFAULT_UI_SLICE.trustedCommands).toEqual([]);
  });

  it("stores each rule once", () => {
    let state = reducer(
      DEFAULT_UI_SLICE,
      addTrustedCommands(["git add*", "git commit*"]),
    );
    state = reducer(state, addTrustedCommands(["git commit*", "npm test*"]));
    expect(state.trustedCommands).toEqual([
      "git add*",
      "git commit*",
      "npm test*",
    ]);
  });

  it("ignores rules that don't start with a command", () => {
    const state = reducer(
      DEFAULT_UI_SLICE,
      addTrustedCommands(["*", "?it", " git*", "Bash(git*)", "git*"]),
    );
    expect(state.trustedCommands).toEqual(["git*"]);
  });

  it("removes a rule", () => {
    let state = reducer(DEFAULT_UI_SLICE, addTrustedCommands(["git push*"]));
    state = reducer(state, removeTrustedCommand("git push*"));
    expect(state.trustedCommands).toEqual([]);
  });
});

describe("trusted fetch hosts", () => {
  it("starts empty, so Read URL asks for every URL", () => {
    expect(DEFAULT_UI_SLICE.trustedFetchHosts).toEqual([]);
  });

  it("stores each host once, in its normalized form", () => {
    let state = reducer(
      DEFAULT_UI_SLICE,
      addTrustedFetchHost("https://GitHub.com/nextcli-dev"),
    );
    state = reducer(state, addTrustedFetchHost("github.com"));
    state = reducer(state, addTrustedFetchHost("*.nextcli.dev"));
    expect(state.trustedFetchHosts).toEqual(["github.com", "*.nextcli.dev"]);
  });

  it("ignores text that isn't a host name", () => {
    const state = reducer(DEFAULT_UI_SLICE, addTrustedFetchHost("localhost"));
    expect(state.trustedFetchHosts).toEqual([]);
  });

  it("removes a host", () => {
    let state = reducer(DEFAULT_UI_SLICE, addTrustedFetchHost("github.com"));
    state = reducer(state, removeTrustedFetchHost("github.com"));
    expect(state.trustedFetchHosts).toEqual([]);
  });
});

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
