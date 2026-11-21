import * as fs from "fs";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveReviews } from "./resolveReviews.js";

vi.mock("../../auth/workos.js", () => ({
  loadAuthConfig: vi.fn(() => null),
  getAccessToken: vi.fn(() => null),
}));

vi.mock("../../env.js", () => ({
  env: { apiBase: "https://api.nextcli.dev" },
}));

vi.mock("../../util/logger.js", () => ({
  logger: { debug: vi.fn() },
}));

vi.mock("fs", async () => {
  const actual = await vi.importActual("fs");
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
  };
});

describe("resolveReviews local discovery", () => {
  const originalCwd = process.cwd;

  beforeEach(() => {
    process.cwd = () => "/test/repo";
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
  });

  afterEach(() => {
    process.cwd = originalCwd;
    vi.restoreAllMocks();
  });

  it("discovers files from .continue/agents/", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === path.join("/test/repo", ".continue", "agents");
    });
    vi.mocked(fs.readdirSync).mockImplementation(((p: fs.PathLike) => {
      if (p === path.join("/test/repo", ".continue", "agents")) {
        return ["security-review.md", "style-check.md"];
      }
      return [];
    }) as typeof fs.readdirSync);

    const reviews = await resolveReviews();
    expect(reviews).toHaveLength(2);
    expect(reviews[0].name).toBe("security review");
    expect(reviews[0].sourceType).toBe("local");
    expect(reviews[0].source).toContain("agents");
  });

  it("discovers files from .continue/checks/", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === path.join("/test/repo", ".continue", "checks");
    });
    vi.mocked(fs.readdirSync).mockImplementation(((p: fs.PathLike) => {
      if (p === path.join("/test/repo", ".continue", "checks")) {
        return ["anti-slop.md"];
      }
      return [];
    }) as typeof fs.readdirSync);

    const reviews = await resolveReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].name).toBe("anti slop");
    expect(reviews[0].source).toContain("checks");
  });

  it("discovers files from both directories without duplicates", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation(((p: fs.PathLike) => {
      const dir = String(p);
      if (dir.endsWith("agents")) {
        return ["security-review.md", "shared.md"];
      }
      if (dir.endsWith("checks")) {
        return ["anti-slop.md", "shared.md"];
      }
      return [];
    }) as typeof fs.readdirSync);

    const reviews = await resolveReviews();
    // agents/security-review.md, agents/shared.md, checks/anti-slop.md
    // checks/shared.md is skipped (duplicate filename, agents/ takes precedence)
    expect(reviews).toHaveLength(3);
    const names = reviews.map((r) => r.name);
    expect(names).toContain("security review");
    expect(names).toContain("shared");
    expect(names).toContain("anti slop");

    // The "shared" entry should come from agents/, not checks/
    const shared = reviews.find((r) => r.name === "shared");
    expect(shared?.source).toContain("agents");
  });

  it("discovers files from .claude/checks/", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      return p === path.join("/test/repo", ".claude", "checks");
    });
    vi.mocked(fs.readdirSync).mockImplementation(((p: fs.PathLike) => {
      if (p === path.join("/test/repo", ".claude", "checks")) {
        return ["stale-comments.md", "notes.txt"];
      }
      return [];
    }) as typeof fs.readdirSync);

    const reviews = await resolveReviews();
    expect(reviews).toEqual([
      {
        name: "stale comments",
        source: path.join(
          "/test/repo",
          ".claude",
          "checks",
          "stale-comments.md",
        ),
        sourceType: "local",
      },
    ]);
  });

  it("keeps the .continue/ file when .claude/checks/ has the same name", async () => {
    const continueChecks = path.join("/test/repo", ".continue", "checks");
    const claudeChecks = path.join("/test/repo", ".claude", "checks");
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === continueChecks || p === claudeChecks,
    );
    vi.mocked(fs.readdirSync).mockImplementation(((p: fs.PathLike) => {
      if (p === continueChecks) return ["anti-slop.md"];
      if (p === claudeChecks) return ["anti-slop.md", "review.md"];
      return [];
    }) as typeof fs.readdirSync);

    const reviews = await resolveReviews();
    expect(reviews.map((r) => r.source)).toEqual([
      path.join(continueChecks, "anti-slop.md"),
      path.join(claudeChecks, "review.md"),
    ]);
  });

  it("does not run Claude Code subagents in .claude/agents/ as reviews", async () => {
    vi.mocked(fs.existsSync).mockImplementation(
      (p) => p === path.join("/test/repo", ".claude", "agents"),
    );
    vi.mocked(fs.readdirSync).mockReturnValue([
      "code-reviewer.md",
    ] as unknown as ReturnType<typeof fs.readdirSync>);

    expect(await resolveReviews()).toEqual([]);
  });

  it("returns empty array when neither directory exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const reviews = await resolveReviews();
    expect(reviews).toHaveLength(0);
  });

  it("handles directory read errors gracefully", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      throw new Error("Permission denied");
    });

    const reviews = await resolveReviews();
    expect(reviews).toHaveLength(0);
  });
});
