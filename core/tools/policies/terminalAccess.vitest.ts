import { describe, expect, it } from "vitest";

import { BuiltInToolNames } from "../builtIn";
import { terminalCommandTrust } from "./terminalAccess";

const RUN = BuiltInToolNames.RunTerminalCommand;

describe("terminalCommandTrust", () => {
  it("trusts a chain of trusted commands under Ask First", () => {
    expect(
      terminalCommandTrust(
        RUN,
        { command: "git add -A && git commit -m x" },
        ["git add*", "git commit*"],
        "allowedWithPermission",
      ),
    ).toEqual({ trusted: true, rememberRules: undefined });
  });

  it("offers the rules for commands that aren't trusted yet", () => {
    expect(
      terminalCommandTrust(
        RUN,
        { command: "git add -A && git commit -m x" },
        ["git add*"],
        "allowedWithPermission",
      ),
    ).toEqual({ trusted: false, rememberRules: ["git commit*"] });
  });

  it("counts commands the evaluator approves under Automatic", () => {
    expect(
      terminalCommandTrust(
        RUN,
        { command: "cd core && npx vitest run" },
        ["npx vitest*"],
        "allowedWithoutPermission",
      ).trusted,
    ).toBe(true);
  });

  it("never trusts what the evaluator refuses or the user excluded", () => {
    expect(
      terminalCommandTrust(
        RUN,
        { command: "ls a#; rm -rf ~" },
        ["ls*", "rm*"],
        "allowedWithoutPermission",
      ),
    ).toEqual({ trusted: false, rememberRules: undefined });
    expect(
      terminalCommandTrust(
        RUN,
        { command: "git push" },
        ["git push*"],
        "disabled",
      ),
    ).toEqual({ trusted: false, rememberRules: undefined });
  });

  it("is empty for other tools and calls without a command", () => {
    expect(
      terminalCommandTrust(
        BuiltInToolNames.ReadFile,
        { command: "git push" },
        ["git push*"],
        "allowedWithPermission",
      ),
    ).toEqual({});
    expect(
      terminalCommandTrust(RUN, {}, ["git push*"], "allowedWithPermission"),
    ).toEqual({});
  });
});
