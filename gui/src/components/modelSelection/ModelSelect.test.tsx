import { act, screen, waitFor, within } from "@testing-library/react";
import type { ModelDescription, SerializedModelControls } from "core";
import type { ResolvedModelSettings } from "core/llm/modelSettings";
import { describe, expect, it, vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import { updateConfig } from "../../redux/slices/configSlice";
import { setModelSettings } from "../../redux/slices/modelSettingsSlice";
import {
  setProfiles,
  setSelectedProfile,
} from "../../redux/slices/profilesSlice";
import { renderWithProviders } from "../../util/test/render";
import ModelSelect from "./ModelSelect";

const CLAUDE_CONTROLS: SerializedModelControls = {
  format: "anthropic",
  efforts: ["low", "medium", "high", "xhigh", "max"],
  thinkingModes: ["off", "hidden", "shown"],
  thinkingUnavailable: {},
  defaultThinking: "shown",
  canShowThinking: true,
  thinkingNeedsEffort: false,
  effortNeedsThinking: false,
  fast: true,
  maxContextLength: 1_000_000,
  experimental: false,
  contextOptions: [64_000, 128_000, 200_000, 256_000, 400_000, 1_000_000],
  defaultContextLength: 200_000,
};

const GEMINI_CONTROLS: SerializedModelControls = {
  format: "gemini",
  efforts: ["low", "high"],
  thinkingModes: ["hidden", "shown"],
  thinkingUnavailable: {
    off: "Gemini Pro models always think. Pick a Flash model to turn thinking off.",
  },
  defaultThinking: "shown",
  canShowThinking: true,
  thinkingNeedsEffort: false,
  effortNeedsThinking: true,
  fast: false,
  maxContextLength: 1_048_576,
  experimental: false,
  contextOptions: [64_000, 128_000, 200_000, 256_000, 400_000, 1_048_576],
  defaultContextLength: 1_048_576,
};

const LOCAL_CONTROLS: SerializedModelControls = {
  ...GEMINI_CONTROLS,
  format: "generic",
  efforts: [],
  thinkingModes: [],
  thinkingUnavailable: {},
  defaultThinking: undefined,
  effortNeedsThinking: false,
  contextOptions: [32_000],
  defaultContextLength: 32_000,
};

function model(
  title: string,
  provider: string,
  name: string,
  controls: SerializedModelControls,
): ModelDescription {
  return {
    title,
    provider,
    underlyingProviderName: provider,
    model: name,
    controls,
  };
}

const OPUS = model("Opus 5.5", "anthropic", "claude-opus-5-5", CLAUDE_CONTROLS);
const GEMINI = model(
  "Gemini 3.1 Pro",
  "gemini",
  "gemini-3.1-pro",
  GEMINI_CONTROLS,
);
const LOCAL = model("Qwen3 Coder", "ollama", "qwen3-coder", LOCAL_CONTROLS);

function resolved(
  key: string,
  partial: Partial<ResolvedModelSettings>,
): ResolvedModelSettings {
  return { key, fast: false, contextLength: 200_000, stored: {}, ...partial };
}

async function setup(
  selected: ModelDescription,
  settings: Record<string, ResolvedModelSettings> = {},
) {
  const ideMessenger = new MockIdeMessenger();
  const updates: unknown[] = [];
  ideMessenger.responseHandlers["modelSettings/update"] = async (data) => {
    updates.push(data);
    return settings;
  };
  ideMessenger.responses["modelSettings/getAll"] = settings;
  const postSpy = vi.spyOn(ideMessenger, "post");
  const result = await renderWithProviders(<ModelSelect />, {
    mockIdeMessenger: ideMessenger,
  });
  await act(async () => {
    const { store } = result;
    store.dispatch(
      setProfiles([
        {
          id: "local",
          title: "Local",
          fullSlug: { ownerSlug: "", packageSlug: "", versionSlug: "" },
          iconUrl: "",
          errors: undefined,
          uri: "",
        },
      ]),
    );
    store.dispatch(setSelectedProfile("local"));
    const config = store.getState().config.config;
    store.dispatch(
      updateConfig({
        ...config,
        modelsByRole: { ...config.modelsByRole, chat: [OPUS, GEMINI, LOCAL] },
        selectedModelByRole: { ...config.selectedModelByRole, chat: selected },
      }),
    );
    store.dispatch(setModelSettings(settings));
  });
  return { ...result, updates, postSpy };
}

async function openMenu(user: Awaited<ReturnType<typeof setup>>["user"]) {
  await user.click(screen.getByTestId("model-select-button"));
  return screen.findByTestId("model-select-menu");
}

describe("ModelSelect", () => {
  it("shows the effort, fast mode and thinking off on the trigger", async () => {
    await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {
        effort: "high",
        fast: true,
        thinking: "off",
      }),
    });
    const trigger = screen.getByTestId("model-select-button");
    expect(trigger).toHaveTextContent("Opus 5.5");
    expect(screen.getByTestId("model-select-effort")).toHaveTextContent("High");
    expect(screen.getByTestId("model-select-fast")).toBeInTheDocument();
    expect(screen.getByTestId("model-select-thinking-off")).toBeInTheDocument();
  });

  it("shows only the rows the model supports", async () => {
    const { user } = await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {
        thinking: "shown",
      }),
    });
    const menu = await openMenu(user);
    const rows = Array.from(menu.querySelectorAll("[data-row]")).map((row) =>
      row.getAttribute("data-row"),
    );
    expect(rows).toEqual(["fast", "thinking", "effort", "context", "models"]);
    expect(within(menu).getByText("Shown")).toBeInTheDocument();
    expect(within(menu).getByText("200K")).toBeInTheDocument();
  });

  it("keeps the narrow width of the old picker", async () => {
    const { user } = await setup(OPUS);
    const menu = await openMenu(user);
    expect(menu.className).toContain("min-w-[160px]");
    expect(menu.className).toContain("max-w-[240px]");
  });

  it("opens straight to the model list for models without settings", async () => {
    const { user } = await setup(LOCAL);
    const menu = await openMenu(user);
    expect(within(menu).getByText("Models")).toBeInTheDocument();
    expect(within(menu).getByText("Add Chat model")).toBeInTheDocument();
    expect(within(menu).queryByText("Fast")).not.toBeInTheDocument();
  });

  it("stays open after toggling Fast", async () => {
    const { user, updates } = await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {}),
    });
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Fast"));
    await waitFor(() =>
      expect(updates).toEqual([
        { key: "anthropic/claude-opus-5-5", patch: { fast: true } },
      ]),
    );
    expect(screen.getByTestId("model-select-menu")).toBeInTheDocument();
  });

  it("stays open and returns to the settings after picking a thinking mode", async () => {
    const { user, updates } = await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {
        thinking: "shown",
      }),
    });
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Thinking"));
    await user.click(screen.getByText("Off"));
    await waitFor(() =>
      expect(updates).toEqual([
        { key: "anthropic/claude-opus-5-5", patch: { thinking: "off" } },
      ]),
    );
    const stillOpen = screen.getByTestId("model-select-menu");
    expect(within(stillOpen).getByText("Fast")).toBeInTheDocument();
  });

  it("stays open after picking an effort or a context window", async () => {
    const { user, updates } = await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {}),
    });
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Effort"));
    await user.click(screen.getByText("Max"));
    await user.click(
      within(screen.getByTestId("model-select-menu")).getByText("Context"),
    );
    await user.click(screen.getByText("1M"));
    await waitFor(() =>
      expect(updates).toEqual([
        { key: "anthropic/claude-opus-5-5", patch: { effort: "max" } },
        {
          key: "anthropic/claude-opus-5-5",
          patch: { contextLength: 1_000_000 },
        },
      ]),
    );
    expect(screen.getByTestId("model-select-menu")).toBeInTheDocument();
  });

  it("explains a thinking mode the model can't use", async () => {
    const { user, updates } = await setup(GEMINI, {
      "gemini/gemini-3.1-pro": resolved("gemini/gemini-3.1-pro", {
        thinking: "shown",
      }),
    });
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Thinking"));
    const off = screen.getByText("Off").closest("button")!;
    expect(off).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByText(/Gemini Pro models always think/),
    ).toBeInTheDocument();
    await user.click(off);
    expect(updates).toEqual([]);
  });

  it("marks effort as needing thinking when thinking is off", async () => {
    const { user } = await setup(
      {
        ...GEMINI,
        controls: {
          ...GEMINI_CONTROLS,
          thinkingModes: ["off", "hidden", "shown"],
        },
      },
      {
        "gemini/gemini-3.1-pro": resolved("gemini/gemini-3.1-pro", {
          thinking: "off",
        }),
      },
    );
    const menu = await openMenu(user);
    const effort = within(menu).getByText("Effort").closest("button")!;
    expect(effort).toHaveAttribute("aria-disabled", "true");
    expect(within(menu).getByText("Needs thinking")).toBeInTheDocument();
  });

  it("switches models from the Model submenu and stays open", async () => {
    const { user, postSpy } = await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {}),
    });
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Model"));
    expect(screen.getByText("Add Chat model")).toBeInTheDocument();
    await user.click(screen.getByText("Gemini 3.1 Pro"));
    expect(postSpy).toHaveBeenCalledWith("config/updateSelectedModel", {
      role: "chat",
      profileId: "local",
      title: "Gemini 3.1 Pro",
    });
    const stillOpen = screen.getByTestId("model-select-menu");
    expect(within(stillOpen).getByText("Thinking")).toBeInTheDocument();
  });

  it("goes back with Escape before closing", async () => {
    const { user } = await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {}),
    });
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Thinking"));
    expect(screen.getByText("Hidden")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(
      within(screen.getByTestId("model-select-menu")).getByText("Fast"),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByTestId("model-select-menu")).not.toBeInTheDocument(),
    );
  });

  it("moves between rows with the arrow keys", async () => {
    const { user } = await setup(OPUS, {
      "anthropic/claude-opus-5-5": resolved("anthropic/claude-opus-5-5", {}),
    });
    const menu = await openMenu(user);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(menu).getByText("Fast").closest("button"),
      ),
    );
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(
      within(menu).getByText("Thinking").closest("button"),
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getByText("Hidden")).toBeInTheDocument();
  });

  it("still cycles models with the keyboard shortcut", async () => {
    const { user, postSpy } = await setup(GEMINI);
    await user.keyboard("{Meta>}'{/Meta}");
    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith(
        "config/updateSelectedModel",
        expect.objectContaining({ title: "Opus 5.5" }),
      ),
    );
  });
});
