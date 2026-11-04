import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { updateConfig } from "../../../redux/slices/configSlice";
import { setModelSettings } from "../../../redux/slices/modelSettingsSlice";
import { renderWithProviders } from "../../../util/test/render";
import ThinkingBlockPeek from "./ThinkingBlockPeek";

const MODEL = {
  title: "Opus 5.5",
  provider: "anthropic",
  underlyingProviderName: "anthropic",
  model: "claude-opus-5-5",
};

async function renderWithThinking(thinking: "hidden" | "shown") {
  const result = await renderWithProviders(
    <ThinkingBlockPeek content="Secret plan" index={0} prevItem={null} />,
  );
  await act(async () => {
    const config = result.store.getState().config.config;
    result.store.dispatch(
      updateConfig({
        ...config,
        selectedModelByRole: { ...config.selectedModelByRole, chat: MODEL },
      }),
    );
    result.store.dispatch(
      setModelSettings({
        "anthropic/claude-opus-5-5": {
          key: "anthropic/claude-opus-5-5",
          thinking,
          fast: false,
          contextLength: 200_000,
          stored: { thinking },
        },
      }),
    );
  });
  return result;
}

describe("ThinkingBlockPeek", () => {
  it("shows that the model thought, not what, when thinking is hidden", async () => {
    const { user } = await renderWithThinking("hidden");
    const peek = screen.getByTestId("thinking-block-peek");
    expect(peek).toHaveTextContent("Thought");
    await user.click(peek);
    expect(screen.queryByText("Secret plan")).not.toBeInTheDocument();
  });

  it("can be opened when thinking is shown", async () => {
    await renderWithThinking("shown");
    expect(screen.getByText("Secret plan")).toBeInTheDocument();
  });
});
