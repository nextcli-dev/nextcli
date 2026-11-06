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
  // The user's choice ("Allow Anonymous Telemetry" in User Settings) reaches
  // doLoadConfig as allowAnonymousTelemetry on the loaded config. It must stay
  // the stored choice, so the settings switch can show and change it; VS
  // Code's own setting is applied by isTelemetryAllowed() when telemetry is
  // configured.
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
    return { config: result.config, ide };
  }

  async function exportsFor(optIn: boolean | undefined, ideTelemetry: boolean) {
    const { config, ide } = await load(optIn, ideTelemetry);
    const http = await import("node:http");
    const { CoreTelemetry, isTelemetryAllowed } = await import(
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
    const telemetry = new CoreTelemetry(
      { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}` },
      { docs_backup_sites: { outcome: ["copied"] } },
    );
    // As core.ts does on every config load
    await telemetry.configure({
      allowAnonymousTelemetry: await isTelemetryAllowed(
        config?.allowAnonymousTelemetry,
        "vscode",
        ide,
      ),
      ideType: "vscode",
    });
    telemetry.count("docs_backup_sites", 1, { outcome: "copied" });
    await telemetry.flush();
    const sent = bodies.length; // shutdown() sends a final export too
    await telemetry.shutdown();
    await new Promise((resolve) => server.close(resolve));
    return { config, sent };
  }

  it("keeps the stored opt-in whatever VS Code's setting is", async () => {
    expect((await load(true, true)).config?.allowAnonymousTelemetry).toBe(true);
    expect((await load(true, false)).config?.allowAnonymousTelemetry).toBe(
      true,
    );
    expect((await load(false, true)).config?.allowAnonymousTelemetry).toBe(
      false,
    );
  });

  it("sends metrics with the opt-in and VS Code telemetry on", async () => {
    expect((await exportsFor(true, true)).sent).toBe(1);
  });

  it("sends nothing without the opt-in, even with VS Code telemetry on", async () => {
    for (const optIn of [undefined, false]) {
      expect((await exportsFor(optIn, true)).sent).toBe(0);
    }
  });

  it("sends nothing while VS Code telemetry is off, keeping the opt-in for later", async () => {
    const { config, sent } = await exportsFor(true, false);
    expect(sent).toBe(0);
    expect(config?.allowAnonymousTelemetry).toBe(true);
  });
});
