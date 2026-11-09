import { parseAgentFileTools } from "@nextcli/config-yaml";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  InitializeToolServiceOverrides,
  ToolPermissionService,
} from "../services/ToolPermissionService.js";
import { AgentFileServiceState } from "../services/types.js";

import { checkToolPermission, isToolOffered } from "./permissionChecker.js";
import type { PermissionsYamlConfig } from "./permissionsYamlLoader.js";
import { PermissionMode } from "./types.js";

/**
 * Behavior matrix for tool permissions: a run setup and a tool call give a
 * decision, and a run setup and a tool name tell whether the model is offered
 * the tool. It drives the real ToolPermissionService, checkToolPermission and
 * the terminal-security evaluator; only reading permissions.yaml is mocked.
 *
 * Refactors must leave every row unchanged. A change in behavior edits the
 * rows it changes, in the same commit. Rows marked "main:" record current
 * behavior that a later change is meant to flip.
 */

let yaml: PermissionsYamlConfig | null = null;

vi.mock("./permissionsYamlLoader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./permissionsYamlLoader.js")>()),
  loadPermissionsYaml: () => yaml,
}));

type Decision = "allow" | "ask" | "deny";

interface Row {
  name: string;
  init?: InitializeToolServiceOverrides;
  /** Someone can answer an ask: the TUI, or cn serve through POST /permission */
  approver: boolean;
  yaml?: PermissionsYamlConfig;
  /** The `tools` line of an agent file */
  agentFileTools?: string;
  steps?: Array<PermissionMode | "reload">;
  calls: Array<
    [tool: string, args: Record<string, unknown>, expected: Decision]
  >;
  offered?: Record<string, boolean>;
}

const MCP_TOOL = "github_create_issue";
const read = ["Read", { filepath: "src/a.ts" }] as const;
const edit = ["Edit", { filepath: "src/a.ts" }] as const;
const fetchUrl = ["Fetch", { url: "https://example.com" }] as const;
const mcp = [MCP_TOOL, { title: "x" }] as const;
const bash = (command: string) => ["Bash", { command }] as const;

const HEADLESS: InitializeToolServiceOverrides = { isHeadless: true };
const READONLY_HEADLESS: InitializeToolServiceOverrides = {
  isHeadless: true,
  mode: "plan",
};

const rows: Row[] = [
  // Interactive (TUI)
  {
    name: "TUI defaults",
    approver: true,
    calls: [
      [...read, "allow"],
      [...edit, "ask"],
      [...bash("ls"), "ask"],
      [...bash("cp a.txt b.txt"), "ask"],
      [...bash("rm -rf /"), "deny"],
      [...fetchUrl, "allow"],
      [...mcp, "ask"],
    ],
    offered: { Bash: true, Edit: true, Fetch: true, [MCP_TOOL]: true },
  },
  {
    name: "TUI remembered Bash(npm*) allow",
    approver: true,
    yaml: { allow: ["Bash(npm*)"] },
    calls: [
      [...bash("npm test"), "allow"],
      // main: an allow glob matches a whole chained line
      [...bash("npm test; curl https://x"), "allow"],
      [...bash("ls"), "ask"],
    ],
  },
  {
    name: "TUI remembered Bash exclude",
    approver: true,
    yaml: { exclude: ["Bash(npm install*)"] },
    calls: [
      [...bash("npm install left-pad"), "deny"],
      // main: an exclude glob is compared to the whole line
      [...bash("ls && npm install left-pad"), "ask"],
    ],
  },
  {
    name: "TUI flags override yaml",
    approver: true,
    init: { allow: ["Edit"] },
    yaml: { exclude: ["Edit"] },
    calls: [[...edit, "allow"]],
  },
  {
    name: "TUI plan mode",
    approver: true,
    init: { mode: "plan" },
    calls: [
      [...read, "allow"],
      [...edit, "deny"],
      [...bash("ls"), "ask"],
      [...fetchUrl, "allow"],
      [...mcp, "ask"],
    ],
    offered: { Edit: false, Write: false, Bash: true },
  },
  {
    name: "TUI auto mode",
    approver: true,
    init: { mode: "auto" },
    calls: [
      [...edit, "allow"],
      [...bash("curl https://x"), "allow"],
      [...bash("rm -rf /"), "deny"],
      [...mcp, "allow"],
    ],
  },
  {
    name: "TUI normal → plan → normal restores the policies",
    approver: true,
    steps: ["plan", "normal"],
    calls: [
      [...edit, "ask"],
      [...bash("ls"), "ask"],
    ],
  },
  {
    name: "TUI normal → auto",
    approver: true,
    steps: ["auto"],
    calls: [[...edit, "allow"]],
  },
  {
    name: "TUI agent file",
    approver: true,
    agentFileTools: "Read, Bash",
    calls: [
      [...read, "allow"],
      [...bash("curl https://x"), "allow"],
      [...edit, "deny"],
      [...mcp, "allow"],
    ],
    offered: { Edit: false, [MCP_TOOL]: true },
  },
  {
    name: "TUI agent file ignores flags",
    approver: true,
    init: { exclude: ["Read"] },
    agentFileTools: "Read, Bash",
    // main: flags are dropped when an agent file is loaded
    calls: [[...read, "allow"]],
  },
  {
    name: "TUI agent file after a permissions reload",
    approver: true,
    agentFileTools: "Read, Bash",
    steps: ["reload"],
    // main: the reload drops the agent file's rules
    calls: [[...edit, "ask"]],
  },

  // Unattended (cn -p)
  {
    name: "headless defaults",
    approver: false,
    init: HEADLESS,
    calls: [
      [...read, "allow"],
      [...edit, "deny"],
      [...bash("ls"), "allow"],
      [...bash("git status"), "allow"],
      // main: unsafe unattended, closed in the headless-defaults change
      [...bash("cp a.txt b.txt"), "allow"],
      [...bash("curl https://x"), "allow"],
      [...bash("git push"), "allow"],
      [...bash("rm -rf /"), "deny"],
      [...fetchUrl, "allow"],
      [...mcp, "allow"],
    ],
    offered: { Edit: false, Bash: true, Fetch: true, [MCP_TOOL]: true },
  },
  {
    name: "headless --exclude Bash",
    approver: false,
    init: { ...HEADLESS, exclude: ["Bash"] },
    calls: [[...bash("ls"), "deny"]],
    offered: { Bash: false },
  },
  {
    name: "headless --allow Edit",
    approver: false,
    init: { ...HEADLESS, allow: ["Edit"] },
    calls: [[...edit, "allow"]],
    offered: { Edit: true },
  },
  {
    name: "headless --exclude Bash(npm install*)",
    approver: false,
    init: { ...HEADLESS, exclude: ["Bash(npm install*)"] },
    calls: [
      [...bash("npm install left-pad"), "deny"],
      // main: chained and wrapped forms get past the exclude
      [...bash("ls && npm install left-pad"), "allow"],
      [...bash("sh -c 'npm install left-pad'"), "allow"],
      [...bash("ls"), "allow"],
    ],
  },
  {
    name: "headless --allow Bash(git log*) on top of --exclude Bash",
    approver: false,
    init: { ...HEADLESS, exclude: ["Bash"], allow: ["Bash(git log*)"] },
    calls: [[...bash("git log"), "deny"]],
    offered: { Bash: false },
  },
  {
    name: "headless remembered allows and excludes",
    approver: false,
    init: HEADLESS,
    yaml: { allow: ["Bash(git*)"], exclude: ["Fetch"] },
    calls: [
      [...bash("git push"), "allow"],
      [...fetchUrl, "deny"],
    ],
    offered: { Fetch: false },
  },
  {
    name: "headless agent file",
    approver: false,
    init: HEADLESS,
    agentFileTools: "Read, Bash",
    calls: [
      [...read, "allow"],
      [...edit, "deny"],
      [...bash("curl https://x"), "allow"],
      [...mcp, "allow"],
    ],
  },

  // Unattended --readonly (what nextcli-checks runs)
  {
    name: "headless --readonly",
    approver: false,
    init: READONLY_HEADLESS,
    calls: [
      [...read, "allow"],
      [...edit, "deny"],
      [...bash("ls"), "deny"],
      [...fetchUrl, "deny"],
      [...mcp, "deny"],
    ],
    offered: {
      Read: true,
      Search: true,
      Edit: false,
      Bash: false,
      Fetch: false,
      [MCP_TOOL]: false,
    },
  },
  {
    name: "headless --readonly ignores --allow",
    approver: false,
    init: { ...READONLY_HEADLESS, allow: ["Bash(git log*)", "Fetch", "Write"] },
    // main: plan mode drops every flag
    calls: [
      [...bash("git log"), "deny"],
      [...fetchUrl, "deny"],
      ["Write", { filepath: "a.txt", content: "x" }, "deny"],
    ],
  },
  {
    name: "headless --readonly ignores an agent file",
    approver: false,
    init: READONLY_HEADLESS,
    agentFileTools: "Read, Bash, Write",
    calls: [
      [...bash("ls"), "deny"],
      ["Write", { filepath: "a.txt", content: "x" }, "deny"],
    ],
  },

  // cn review worker: headless, auto mode
  {
    name: "review worker",
    approver: false,
    init: { ...HEADLESS, mode: "auto" },
    calls: [
      [...edit, "allow"],
      // main: the worker reviews untrusted diffs with full access
      [...bash("curl https://x"), "allow"],
      [...mcp, "allow"],
    ],
  },

  // cn serve: headless service state, approvals through POST /permission
  {
    name: "cn serve",
    approver: true,
    init: HEADLESS,
    calls: [
      [...edit, "ask"],
      [...bash("ls"), "allow"],
    ],
    offered: { Edit: true },
  },
];

function decide(
  service: ToolPermissionService,
  name: string,
  args: Record<string, unknown>,
  approver: boolean,
): Decision {
  const { permission } = checkToolPermission(
    { name, arguments: args },
    service.getPermissions(),
  );
  if (permission === "exclude") return "deny";
  if (permission === "ask") return approver ? "ask" : "deny";
  return "allow";
}

function agentFileState(tools: string): AgentFileServiceState {
  return {
    agentFile: { name: "agent", tools } as any,
    slug: "agent",
    agentFileModel: null,
    parsedTools: parseAgentFileTools(tools),
    parsedRules: null,
  };
}

describe.each(rows)("permission matrix: $name", (row) => {
  let service: ToolPermissionService;

  beforeEach(async () => {
    yaml = row.yaml ?? null;
    service = new ToolPermissionService();
    service.initializeSync(
      row.init ?? {},
      row.agentFileTools ? agentFileState(row.agentFileTools) : undefined,
    );
    for (const step of row.steps ?? []) {
      if (step === "reload") {
        await service.reloadPermissions();
      } else {
        service.switchMode(step);
      }
    }
  });

  it.each(row.calls)("%s %j → %s", (tool, args, expected) => {
    expect(decide(service, tool, args, row.approver)).toBe(expected);
  });

  if (row.offered) {
    it.each(Object.entries(row.offered))("offers %s: %s", (tool, expected) => {
      expect(isToolOffered(tool, service.getPermissions(), !row.approver)).toBe(
        expected,
      );
    });
  }
});
