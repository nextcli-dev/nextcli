import { describe, expect, it, vi } from "vitest";

import type { PackageIdentifier } from "@nextcli/config-yaml";

// Mock heavy dependencies before importing doLoadConfig
const stubConfig = {
  models: [],
  rules: [],
  tools: [],
  slashCommands: [],
  contextProviders: [],
  modelsByRole: { chat: [], edit: [], apply: [], summarize: [], rerank: [] },
  selectedModelByRole: {},
  mcpServerStatuses: [],
  allowAnonymousTelemetry: false,
  experimental: {},
};
const mockLoadYaml = vi.fn().mockResolvedValue({
  config: { ...stubConfig },
  errors: [],
  configLoadInterrupted: false,
});
const mockLoadJson = vi.fn().mockResolvedValue({
  config: { ...stubConfig },
  errors: [],
  configLoadInterrupted: false,
});

vi.mock("../yaml/loadYaml", () => ({
  loadContinueConfigFromYaml: (...args: any[]) => mockLoadYaml(...args),
}));
vi.mock("../load", () => ({
  loadContinueConfigFromJson: (...args: any[]) => mockLoadJson(...args),
}));
vi.mock("../migrateSharedConfig", () => ({
  migrateJsonSharedConfig: vi.fn(),
}));
vi.mock("../getWorkspaceContinueRuleDotFiles", () => ({
  getWorkspaceContinueRuleDotFiles: vi
    .fn()
    .mockResolvedValue({ rules: [], errors: [] }),
}));
vi.mock("../markdown/loadMarkdownRules", () => ({
  loadMarkdownRules: vi.fn().mockResolvedValue({ rules: [], errors: [] }),
}));
vi.mock("../markdown/loadCodebaseRules", () => ({
  CodebaseRulesCache: { getInstance: () => ({ rules: [], errors: [] }) },
}));
vi.mock("../selectedModels", () => ({
  rectifySelectedModelsFromGlobalContext: (c: any) => c,
}));
vi.mock("../../context/mcp/MCPManagerSingleton", () => ({
  MCPManagerSingleton: { getInstance: () => ({ getStatuses: () => [] }) },
}));
vi.mock("../../tools", () => ({
  getConfigDependentToolDefinitions: vi.fn().mockResolvedValue([]),
}));
vi.mock("../../tools/callTool", () => ({
  encodeMCPToolUri: vi.fn(),
}));
vi.mock("../../tools/mcpToolName", () => ({
  getMCPToolName: vi.fn(),
}));
vi.mock("../../util/tts", () => ({
  TTS: { setup: vi.fn() },
}));
vi.mock("../../util/GlobalContext", () => ({
  GlobalContext: class {
    get() {
      return {};
    }
    update() {}
  },
}));
vi.mock("../../promptFiles/initPrompt", () => ({
  initSlashCommand: { name: "init", description: "init" },
}));

// Mock fs.existsSync to simulate missing file on disk
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn().mockReturnValue(false),
    },
  };
});

import doLoadConfig from "./doLoadConfig.js";

const mockIde = {
  getIdeInfo: vi.fn().mockResolvedValue({
    ideType: "vscode",
    name: "VS Code",
    version: "1.90.0",
    remoteName: "wsl",
    extensionVersion: "1.3.31",
  }),
  getUniqueId: vi.fn().mockResolvedValue("test-id"),
  getIdeSettings: vi.fn().mockResolvedValue({}),
  showToast: vi.fn(),
  isTelemetryEnabled: vi.fn().mockResolvedValue(true),
  isWorkspaceRemote: vi.fn().mockResolvedValue(true),
} as any;

const mockLlmLogger = {} as any;

describe("doLoadConfig pre-read content bypass", () => {
  it("should use YAML loading when packageIdentifier has pre-read content, even if file does not exist on disk", async () => {
    mockLoadYaml.mockClear();
    mockLoadJson.mockClear();

    const packageIdentifier: PackageIdentifier = {
      uriType: "file",
      fileUri:
        "vscode-remote://wsl+Ubuntu/home/user/.continue/agents/test.yaml",
      content: "name: Test\nversion: 1.0.0\nschema: v1\n",
    };

    await doLoadConfig({
      ide: mockIde,

      llmLogger: mockLlmLogger,
      profileId: "test-profile",
      overrideConfigYamlByPath: packageIdentifier.fileUri,

      packageIdentifier,
    });

    expect(mockLoadYaml).toHaveBeenCalled();
    expect(mockLoadJson).not.toHaveBeenCalled();
  });

  it("should fall back to JSON loading when no content and file does not exist", async () => {
    mockLoadYaml.mockClear();
    mockLoadJson.mockClear();

    const packageIdentifier: PackageIdentifier = {
      uriType: "file",
      fileUri:
        "vscode-remote://wsl+Ubuntu/home/user/.continue/agents/test.yaml",
    };

    await doLoadConfig({
      ide: mockIde,

      llmLogger: mockLlmLogger,
      profileId: "test-profile",
      overrideConfigYamlByPath: packageIdentifier.fileUri,

      packageIdentifier,
    });

    expect(mockLoadYaml).not.toHaveBeenCalled();
    expect(mockLoadJson).toHaveBeenCalled();
  });
});

describe("doLoadConfig and the telemetry opt-in", () => {
  // The user's opt-in ("Allow Anonymous Telemetry" in User Settings) reaches
  // doLoadConfig as allowAnonymousTelemetry on the loaded config; VS Code's
  // own setting comes from ide.isTelemetryEnabled().
  async function load(optIn: boolean | undefined, ideTelemetry: boolean) {
    mockLoadJson.mockResolvedValueOnce({
      config: { ...stubConfig, allowAnonymousTelemetry: optIn },
      errors: [],
      configLoadInterrupted: false,
    });
    const ide = {
      ...mockIde,
      isTelemetryEnabled: vi.fn().mockResolvedValue(ideTelemetry),
    };
    const result = await doLoadConfig({
      ide,
      llmLogger: mockLlmLogger,
      profileId: "test-profile",
      overrideConfigYamlByPath: undefined,
      packageIdentifier: {
        uriType: "file",
        fileUri: "file:///home/user/.continue/config.json",
      },
    });
    return result.config;
  }

  async function requestsAfterConfigure(allowAnonymousTelemetry?: boolean) {
    const http = await import("node:http");
    const { CoreTelemetry } = await import(
      "../../util/telemetry/coreTelemetry"
    );
    const bodies: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        bodies.push(body);
        res.end("{}");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as { port: number }).port;
    const telemetry = new CoreTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
    });
    await telemetry.configure({ allowAnonymousTelemetry, ideType: "vscode" });
    telemetry.count("docs_backup_sites");
    await telemetry.flush();
    const sent = bodies.length; // shutdown() sends a final export too
    await telemetry.shutdown();
    await new Promise((resolve) => server.close(resolve));
    return sent;
  }

  it("keeps the user's opt-in when VS Code telemetry is on, and metrics are sent", async () => {
    const config = await load(true, true);
    expect(config?.allowAnonymousTelemetry).toBe(true);
    expect(await requestsAfterConfigure(config?.allowAnonymousTelemetry)).toBe(
      1,
    );
  });

  it("sends nothing without the user's opt-in, even with VS Code telemetry on", async () => {
    for (const optIn of [undefined, false]) {
      const config = await load(optIn, true);
      expect(config?.allowAnonymousTelemetry).not.toBe(true);
      expect(
        await requestsAfterConfigure(config?.allowAnonymousTelemetry),
      ).toBe(0);
    }
  });

  it("turns the opt-in off when VS Code telemetry is off", async () => {
    const config = await load(true, false);
    expect(config?.allowAnonymousTelemetry).toBe(false);
    expect(await requestsAfterConfigure(config?.allowAnonymousTelemetry)).toBe(
      0,
    );
  });
});
