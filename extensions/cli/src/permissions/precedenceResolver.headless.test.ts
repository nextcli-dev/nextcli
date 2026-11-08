import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkToolPermission } from "./permissionChecker.js";
import type { PermissionsYamlConfig } from "./permissionsYamlLoader.js";
import { resolvePermissionPrecedence } from "./precedenceResolver.js";

// What the terminal UI wrote after "don't ask again" answers
let yamlConfig: PermissionsYamlConfig | null = null;

vi.mock("./permissionsYamlLoader.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./permissionsYamlLoader.js")>();
  return { ...actual, loadPermissionsYaml: () => yamlConfig };
});

function resolve(
  isHeadless: boolean,
  commandLineFlags?: { allow?: string[]; exclude?: string[] },
) {
  return {
    policies: resolvePermissionPrecedence({
      commandLineFlags,
      personalSettings: true,
      useDefaults: true,
      isHeadless,
    }),
  };
}

const fetchCall = { name: "Fetch", arguments: { url: "https://example.com" } };
const writeCall = {
  name: "Write",
  arguments: { filepath: "a.txt", content: "x" },
};

describe("permissions.yaml in headless runs", () => {
  beforeEach(() => {
    yamlConfig = {
      allow: ["Fetch", "Bash"],
      ask: ["Edit"],
      exclude: ["Write"],
    };
  });

  it("keeps only the yaml excludes", () => {
    const yamlTools = resolve(true)
      .policies.filter((policy) => !policy.source)
      .map((policy) => `${policy.tool}:${policy.permission}`);

    expect(yamlTools).toEqual(["Write:exclude"]);
  });

  it("does not let a yaml allow reopen a tool the headless defaults close", () => {
    expect(checkToolPermission(fetchCall, resolve(true)).permission).toBe(
      "exclude",
    );
  });

  it("still applies a yaml exclude", () => {
    expect(
      checkToolPermission(writeCall, resolve(true, { allow: ["Edit"] }))
        .permission,
    ).toBe("exclude");
  });

  it("lets --allow opt a headless run in to a tool", () => {
    expect(
      checkToolPermission(fetchCall, resolve(true, { allow: ["Fetch"] }))
        .permission,
    ).toBe("allow");
  });

  it("keeps every yaml rule in the terminal UI", () => {
    const tui = resolve(false);

    expect(checkToolPermission(fetchCall, tui).permission).toBe("allow");
    expect(checkToolPermission(writeCall, tui).permission).toBe("exclude");
  });
});
