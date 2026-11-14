import { beforeEach, describe, expect, it, vi } from "vitest";

const registered: { provider: unknown; dispose: ReturnType<typeof vi.fn> }[] =
  [];

vi.mock("vscode", () => ({
  languages: {
    registerCodeLensProvider: vi.fn((_selector: unknown, provider: unknown) => {
      const entry = { provider, dispose: vi.fn() };
      registered.push(entry);
      return { dispose: entry.dispose };
    }),
  },
}));

vi.mock("./providers", () => {
  class VerticalPerLineCodeLensProvider {
    constructor(public blocks: unknown) {}
    refresh() {}
  }
  class SuggestionsCodeLensProvider {}
  class ConfigJsonConverterCodeLensProvider {}
  class DownloadYamlExtensionCodeLensProvider {}
  class QuickActionsCodeLensProvider {}
  return {
    VerticalPerLineCodeLensProvider,
    SuggestionsCodeLensProvider,
    ConfigJsonConverterCodeLensProvider,
    DownloadYamlExtensionCodeLensProvider,
    QuickActionsCodeLensProvider,
  };
});

vi.mock("./providers/QuickActionsCodeLensProvider", () => ({
  getQuickActionsConfig: vi.fn(),
  quickActionsEnabledStatus: vi.fn(() => false),
  subscribeToVSCodeQuickActionsSettings: vi.fn(),
}));

import * as providers from "./providers";
import { registerAllCodeLensProviders } from "./registerAllCodeLensProviders";

describe("registerAllCodeLensProviders", () => {
  beforeEach(() => {
    registered.length = 0;
  });

  it("keeps the same diff CodeLens provider registered across config reloads", () => {
    const context = { subscriptions: [] as unknown[] } as any;
    const blocks = new Map();

    const first = registerAllCodeLensProviders(context, blocks, undefined);
    // A config reload registers the providers again
    const second = registerAllCodeLensProviders(context, blocks, undefined);

    expect(second.verticalDiffCodeLens).toBe(first.verticalDiffCodeLens);
    const diffProviders = registered.filter(
      (entry) =>
        entry.provider instanceof providers.VerticalPerLineCodeLensProvider,
    );
    // The provider refresh() reaches is the one VS Code has registered
    expect(diffProviders.map((entry) => entry.provider)).toEqual([
      first.verticalDiffCodeLens,
    ]);
    expect(diffProviders[0].dispose).not.toHaveBeenCalled();
  });

  it("still replaces the providers that depend on the config", () => {
    const context = { subscriptions: [] as unknown[] } as any;
    registerAllCodeLensProviders(context, new Map(), undefined);
    const suggestions = registered.find(
      (entry) =>
        entry.provider instanceof providers.SuggestionsCodeLensProvider,
    )!;

    registerAllCodeLensProviders(context, new Map(), undefined);

    expect(suggestions.dispose).toHaveBeenCalledTimes(1);
  });
});
