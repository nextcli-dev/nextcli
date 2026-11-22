import { ToolPolicy } from "@continuedev/terminal-security";
import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { fetchUrlContentTool } from "core/tools/definitions/fetchUrlContent";
import { readFileTool } from "core/tools/definitions/readFile";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { evaluateToolPolicies } from "./evaluateToolPolicies";

function call(name: string, args: Record<string, unknown>): ToolCallState {
  return {
    toolCallId: `call-${name}`,
    toolCall: {
      id: `call-${name}`,
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    },
    status: "generated",
    parsedArgs: args,
  };
}

const fetchCall = (url: string) =>
  call(BuiltInToolNames.FetchUrlContent, { url });

async function policyOf(
  toolCall: ToolCallState,
  trustedFetchHosts: string[],
  toolPolicies: Record<string, ToolPolicy> = {},
): Promise<ToolPolicy> {
  const [result] = await evaluateToolPolicies(
    vi.fn(),
    new MockIdeMessenger(),
    [fetchUrlContentTool, readFileTool],
    [toolCall],
    toolPolicies,
    trustedFetchHosts,
  );
  return result.policy;
}

describe("evaluateToolPolicies with trusted fetch hosts", () => {
  const PR_URL = "https://github.com/nextcli-dev/nextcli/pull/203";

  it("runs Read URL without asking on a trusted host", async () => {
    expect(await policyOf(fetchCall(PR_URL), ["github.com"])).toBe(
      "allowedWithoutPermission",
    );
  });

  it("still asks for a host that isn't trusted, or with no hosts", async () => {
    expect(
      await policyOf(fetchCall("https://evil.example/?q=secret"), [
        "github.com",
      ]),
    ).toBe("allowedWithPermission");
    expect(await policyOf(fetchCall(PR_URL), [])).toBe("allowedWithPermission");
    expect(
      await policyOf(fetchCall("http://github.com/a"), ["github.com"]),
    ).toBe("allowedWithPermission");
  });

  it("keeps Read URL excluded when the user excluded it", async () => {
    expect(
      await policyOf(fetchCall(PR_URL), ["github.com"], {
        [BuiltInToolNames.FetchUrlContent]: "disabled",
      }),
    ).toBe("disabled");
  });

  it("doesn't let a trusted host relax another tool", async () => {
    expect(
      await policyOf(
        call(BuiltInToolNames.ReadFile, { filepath: "https://github.com/x" }),
        ["github.com"],
        { [BuiltInToolNames.ReadFile]: "allowedWithPermission" },
      ),
    ).toBe("allowedWithPermission");
  });
});
