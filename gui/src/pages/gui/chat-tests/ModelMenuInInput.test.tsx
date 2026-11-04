import { act, screen, waitFor, within } from "@testing-library/react";
import type { ModelDescription, SerializedModelControls } from "core";
import { describe, expect, it } from "vitest";
import { updateConfig } from "../../../redux/slices/configSlice";
import {
  setProfiles,
  setSelectedProfile,
} from "../../../redux/slices/profilesSlice";
import { renderWithProviders } from "../../../util/test/render";
import { Chat } from "../Chat";

const CONTROLS: SerializedModelControls = {
  format: "generic",
  efforts: ["low", "medium", "high"],
  thinkingModes: ["hidden", "shown"],
  thinkingUnavailable: {
    off: "NextCli can't turn thinking off for this provider.",
  },
  defaultThinking: "shown",
  canShowThinking: true,
  thinkingNeedsEffort: false,
  effortNeedsThinking: false,
  fast: false,
  experimental: true,
  contextOptions: [8000],
  defaultContextLength: 8000,
};

function model(title: string, name: string): ModelDescription {
  return {
    title,
    provider: "openai",
    underlyingProviderName: "openai",
    model: name,
    controls: CONTROLS,
  };
}

const GEMINI = model("Gemini 3.1 Pro", "gemini-3.1-pro");
const OPUS = model("Opus 5.5", "claude-opus-5-5");

/** Lets the editor's requestAnimationFrame focus run, if one was queued */
const nextFrames = () =>
  act(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

async function setup() {
  const result = await renderWithProviders(<Chat />);
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
        modelsByRole: { ...config.modelsByRole, chat: [GEMINI, OPUS] },
        selectedModelByRole: { ...config.selectedModelByRole, chat: GEMINI },
      }),
    );
  });
  return result;
}

async function openMenu(user: Awaited<ReturnType<typeof setup>>["user"]) {
  const [button] = await screen.findAllByTestId("model-select-button");
  await user.click(button);
  return screen.findByTestId("model-select-menu");
}

// The menu is portalled, but React bubbles its clicks to the input box,
// whose click handler focused the editor and so closed the menu
describe("model menu inside the chat input", () => {
  it("stays open on the Model list", async () => {
    const { user } = await setup();
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Model"));
    await nextFrames();
    const stillOpen = screen.getByTestId("model-select-menu");
    expect(within(stillOpen).getByText("Add Chat model")).toBeInTheDocument();
  });

  it("stays open on a settings submenu", async () => {
    const { user } = await setup();
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Thinking"));
    await nextFrames();
    const stillOpen = screen.getByTestId("model-select-menu");
    expect(within(stillOpen).getByText("Hidden")).toBeInTheDocument();
  });

  it("switches the model from the list", async () => {
    const { user, store } = await setup();
    const menu = await openMenu(user);
    await user.click(within(menu).getByText("Model"));
    await nextFrames();
    await user.click(
      within(screen.getByTestId("model-select-menu")).getByText("Opus 5.5"),
    );
    await waitFor(() =>
      expect(
        store.getState().config.config.selectedModelByRole.chat?.title,
      ).toBe("Opus 5.5"),
    );
  });
});
