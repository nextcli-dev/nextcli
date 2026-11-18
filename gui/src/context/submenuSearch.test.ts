import { describe, expect, it } from "vitest";
import {
  createSubmenuMiniSearch,
  MINISEARCH_OPTIONS,
  rankFileSearchResults,
} from "./submenuSearch";

// Paths from this repository, where the old ranking buried AGENTS.md
const PATHS = [
  "AGENTS.md",
  "README.md",
  "package.json",
  "extensions/cli/AGENTS.md",
  "extensions/cli/src/subagent/get-agents.ts",
  "extensions/cli/src/services/AgentFileService.ts",
  "extensions/cli/src/stream/agentLoopLimits.ts",
  "gui/src/components/BackgroundMode/AgentsList.tsx",
  "gui/src/util/cn.ts",
  "gui/README.md",
  "core/util/ca.ts",
  "core/tools/definitions/ls.ts",
  "packages/config-yaml/src/markdown/agentFiles.ts",
  "packages/config-yaml/src/markdown/agentFiles.test.ts",
  "packages/llm-info/src/providers/os.ts",
  "packages/fetch/package.json",
  "packages/fetch/src/index.ts",
  "docs/agents/overview.md",
];

const minisearch = createSubmenuMiniSearch(
  PATHS.map((path) => ({
    id: `file:///repo/${path}`,
    title: path.split("/").pop()!,
    description: path,
    providerTitle: "file",
  })),
);

function search(query: string, openPaths: string[] = []) {
  const results = minisearch.search(query, MINISEARCH_OPTIONS).map((r) => ({
    ...r,
    id: r.id as string,
    title: r.title as string,
    description: r.description as string,
  }));
  return rankFileSearchResults(
    results,
    query,
    new Set(openPaths.map((path) => `file:///repo/${path}`)),
  ).map((r) => r.description);
}

describe("rankFileSearchResults", () => {
  it.each([
    "agents",
    "AGENTS",
    "agents.md",
    "AGENTS.md",
    "agentsmd",
    "agents.m",
  ])("puts an AGENTS.md first for %j", (query) => {
    expect(search(query).slice(0, 2).sort()).toEqual([
      "AGENTS.md",
      "extensions/cli/AGENTS.md",
    ]);
  });

  it("prefers the shorter name among names that start with the query", () => {
    const results = search("agent");
    expect(results[0]).toBe("AGENTS.md");
    expect(results.indexOf("AGENTS.md")).toBeLessThan(
      results.indexOf("packages/config-yaml/src/markdown/agentFiles.ts"),
    );
  });

  it("matches a camelCase word inside the name", () => {
    expect(search("list")[0]).toBe(
      "gui/src/components/BackgroundMode/AgentsList.tsx",
    );
  });

  it("finds README.md and package.json by name", () => {
    expect(search("readme")[0]).toBe("README.md");
    expect(search("package.json").slice(0, 2).sort()).toEqual([
      "package.json",
      "packages/fetch/package.json",
    ]);
  });

  it("ranks a name match above a source file that only matches fuzzily", () => {
    // "md" is within two edits of "ts", "ca", "cn", "ls" and "os"
    const results = search("agents.md");
    const fuzzyOnly = [
      "core/util/ca.ts",
      "gui/src/util/cn.ts",
      "core/tools/definitions/ls.ts",
      "packages/llm-info/src/providers/os.ts",
    ].map((path) => results.indexOf(path));
    for (const index of fuzzyOnly.filter((i) => i >= 0)) {
      expect(index).toBeGreaterThan(results.indexOf("AGENTS.md"));
      expect(index).toBeGreaterThan(
        results.indexOf("extensions/cli/AGENTS.md"),
      );
    }
  });

  it("puts an open file first among equally good matches", () => {
    expect(search("agents", ["extensions/cli/AGENTS.md"])[0]).toBe(
      "extensions/cli/AGENTS.md",
    );
  });

  it("doesn't let an open file that matches worse jump ahead", () => {
    const results = search("agents", [
      "extensions/cli/src/subagent/get-agents.ts",
    ]);
    expect(results.slice(0, 2).sort()).toEqual([
      "AGENTS.md",
      "extensions/cli/AGENTS.md",
    ]);
    expect(
      results.indexOf("extensions/cli/src/subagent/get-agents.ts"),
    ).toBeGreaterThan(1);
  });

  it("returns nothing to rank for an empty list", () => {
    expect(rankFileSearchResults([], "agents", new Set())).toEqual([]);
  });
});
