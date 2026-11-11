import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { readTerminalPassEnv } from "./terminalPassEnv";

const settingsWith = (values: {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}) => ({
  inspect: <T>() =>
    ({ key: "continue.terminalPassEnv", defaultValue: [], ...values }) as T,
});

// A repository's .vscode/settings.json must not choose which secrets the
// agent's commands see
describe("readTerminalPassEnv", () => {
  it("returns the user's setting", () => {
    expect(
      readTerminalPassEnv(settingsWith({ globalValue: ["NPM_TOKEN"] }) as any),
    ).toEqual(["NPM_TOKEN"]);
  });

  it("ignores workspace and folder values", () => {
    const fromRepository = {
      workspaceValue: ["OPENAI_API_KEY"],
      workspaceFolderValue: ["GITHUB_TOKEN"],
    };
    expect(readTerminalPassEnv(settingsWith(fromRepository) as any)).toEqual(
      [],
    );
    expect(
      readTerminalPassEnv(
        settingsWith({ ...fromRepository, globalValue: ["NPM_TOKEN"] }) as any,
      ),
    ).toEqual(["NPM_TOKEN"]);
  });

  it("drops entries that aren't names and defaults to none", () => {
    expect(
      readTerminalPassEnv(
        settingsWith({ globalValue: ["NPM_TOKEN", 1, null] }) as any,
      ),
    ).toEqual(["NPM_TOKEN"]);
    expect(readTerminalPassEnv(settingsWith({}) as any)).toEqual([]);
    expect(
      readTerminalPassEnv(settingsWith({ globalValue: "NPM_TOKEN" }) as any),
    ).toEqual([]);
  });

  it("is declared machine-scoped, so VS Code ignores workspace values too", () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8"),
    );
    const property =
      manifest.contributes.configuration.properties["continue.terminalPassEnv"];
    expect(property.scope).toBe("machine");
  });
});
