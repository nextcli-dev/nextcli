import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({}));

import { mergeYamlSchemas } from "./yamlSchema";

const ID = "nextcli.nextcli";
const EXT_DIR = "file:///Users/me/.vscode/extensions";
const NEW_PATH = `${EXT_DIR}/nextcli.nextcli-1.4.1-darwin-arm64/config-yaml-schema.json`;
const MATCHER = [".continue/**/*.yaml"];

// #12948: the schema was written on every activation, and old versions'
// entries piled up in the user's settings.json
describe("mergeYamlSchemas", () => {
  it("adds the schema to empty settings", () => {
    expect(mergeYamlSchemas({}, NEW_PATH, ID)).toEqual({
      [NEW_PATH]: MATCHER,
    });
  });

  it("removes entries from older versions of this extension", () => {
    const current = {
      [`${EXT_DIR}/nextcli.nextcli-1.3.40-darwin-arm64/config-yaml-schema.json`]:
        MATCHER,
      [`${EXT_DIR}/nextcli.nextcli-1.4.0/config-yaml-schema.json`]: MATCHER,
    };
    expect(mergeYamlSchemas(current, NEW_PATH, ID)).toEqual({
      [NEW_PATH]: MATCHER,
    });
  });

  it("keeps entries from other extensions and the user", () => {
    const continueSchema = `${EXT_DIR}/continue.continue-1.2.0/config-yaml-schema.json`;
    const userSchema = "https://json.schemastore.org/github-workflow.json";
    const current = {
      [continueSchema]: MATCHER,
      [userSchema]: [".github/workflows/*.yml"],
    };
    expect(mergeYamlSchemas(current, NEW_PATH, ID)).toEqual({
      ...current,
      [NEW_PATH]: MATCHER,
    });
  });

  it("returns undefined when the settings are already current", () => {
    const current = {
      "https://example.com/schema.json": ["*.yaml"],
      [NEW_PATH]: MATCHER,
    };
    expect(mergeYamlSchemas(current, NEW_PATH, ID)).toBeUndefined();
  });

  it("repairs a changed matcher for the current schema", () => {
    expect(mergeYamlSchemas({ [NEW_PATH]: ["*.yaml"] }, NEW_PATH, ID)).toEqual({
      [NEW_PATH]: MATCHER,
    });
  });
});

describe("package.json contributes", () => {
  it("declares each command once", () => {
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "../../package.json"), "utf8"),
    );
    const ids: string[] = manifest.contributes.commands.map(
      (c: { command: string }) => c.command,
    );
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });
});
