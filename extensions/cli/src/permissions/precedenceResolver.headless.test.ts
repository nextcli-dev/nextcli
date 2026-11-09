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

describe("safe remembered rules in a headless run", () => {
  beforeEach(() => {
    yamlConfig = {
      allow: [
        "Bash(ls*)",
        "Bash(*)",
        "Fetch(https://example.com*)",
        "Fetch(*)",
        "Write",
        "github_*",
        "Bash*",
      ],
      ask: ["Edit"],
      exclude: ["Search"],
    };
  });

  it("keeps scoped allows and open built-ins, and drops the rest", () => {
    const yamlTools = resolve(true)
      .policies.filter((policy) => !policy.source)
      .map((policy) => {
        const args = policy.argumentMatches
          ? `(${Object.values(policy.argumentMatches).join(",")})`
          : "";
        return `${policy.tool}${args}:${policy.permission}`;
      });

    expect(yamlTools).toEqual([
      "Search:exclude",
      "Bash(ls*):allow",
      "Fetch(https://example.com*):allow",
      "Write:allow",
    ]);
  });

  it("lets a remembered ls run and still asks for other shell commands", () => {
    const permissions = resolve(true);

    expect(
      checkToolPermission(
        { name: "Bash", arguments: { command: "ls -la" } },
        permissions,
      ).permission,
    ).toBe("allow");
    expect(
      checkToolPermission(
        { name: "Bash", arguments: { command: "cp a.txt b.txt" } },
        permissions,
      ).permission,
    ).toBe("ask");
  });

  it("keeps a remembered Fetch pattern and drops one that matches every url", () => {
    const permissions = resolve(true);

    expect(
      checkToolPermission(
        { name: "Fetch", arguments: { url: "https://example.com/a" } },
        permissions,
      ).permission,
    ).toBe("allow");
    expect(
      checkToolPermission(
        { name: "Fetch", arguments: { url: "https://evil.example" } },
        permissions,
      ).permission,
    ).toBe("exclude");
  });
});

describe("a machine-wide exclude in a headless run", () => {
  beforeEach(() => {
    yamlConfig = { allow: [], ask: [], exclude: ["Bash"] };
  });

  it("removes the shell, including commands the evaluator would allow", () => {
    expect(
      checkToolPermission(
        { name: "Bash", arguments: { command: "ls" } },
        resolve(true),
      ).permission,
    ).toBe("exclude");
  });
});

describe("a remembered allow with a scoped exclude in the terminal UI", () => {
  beforeEach(() => {
    yamlConfig = { allow: ["Bash"], ask: [], exclude: ["Bash(rm *)"] };
  });

  it("applies the exclude and keeps the allow for other commands", () => {
    const tui = resolve(false);

    expect(
      checkToolPermission(
        { name: "Bash", arguments: { command: "rm file.txt" } },
        tui,
      ).permission,
    ).toBe("exclude");
    expect(
      checkToolPermission(
        { name: "Bash", arguments: { command: "npm test" } },
        tui,
      ).permission,
    ).toBe("allow");
  });
});

describe("a remembered allow for a built-in the headless defaults exclude", () => {
  beforeEach(() => {
    yamlConfig = { allow: ["UploadArtifact", "Write"], ask: [], exclude: [] };
  });

  it("drops UploadArtifact and keeps Write", () => {
    const permissions = resolve(true);
    const kept = permissions.policies
      .filter((policy) => !policy.source)
      .map((policy) => `${policy.tool}:${policy.permission}`);

    expect(kept).toEqual(["Write:allow"]);
    expect(
      checkToolPermission(
        { name: "UploadArtifact", arguments: { filepath: "secret.txt" } },
        permissions,
      ).permission,
    ).toBe("exclude");
  });
});
