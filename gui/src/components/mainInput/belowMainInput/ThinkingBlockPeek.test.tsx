import { act, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { updateConfig } from "../../../redux/slices/configSlice";
import { setModelSettings } from "../../../redux/slices/modelSettingsSlice";
import { varWithFallback } from "../../../styles/theme";
import { renderWithProviders } from "../../../util/test/render";
import ThinkingBlockPeek from "./ThinkingBlockPeek";

const MODEL = {
  title: "GPT-5.5",
  provider: "openai",
  underlyingProviderName: "openai",
  model: "gpt-5.5",
};

/** Makes the selected chat model's Thinking mode Hidden */
async function selectHiddenModel(store: any) {
  await act(async () => {
    const config = store.getState().config.config;
    store.dispatch(
      updateConfig({
        ...config,
        selectedModelByRole: { ...config.selectedModelByRole, chat: MODEL },
      }),
    );
    store.dispatch(
      setModelSettings({
        "openai/gpt-5.5": {
          key: "openai/gpt-5.5",
          thinking: "hidden",
          fast: false,
          contextLength: 400_000,
          stored: {},
        },
      }),
    );
  });
}

describe("ThinkingBlockPeek", () => {
  it("shows that the model thought, not what, for a hidden block", async () => {
    const { user } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Secret plan"
        index={0}
        prevItem={null}
        hidden
      />,
    );
    const peek = screen.getByTestId("thinking-block-peek");
    expect(peek).toHaveTextContent("Thought");
    await user.click(peek);
    expect(screen.queryByText("Secret plan")).not.toBeInTheDocument();
  });

  it("opens a shown block", async () => {
    const { user } = await renderWithProviders(
      <ThinkingBlockPeek content="Visible plan" index={0} prevItem={null} />,
    );
    await user.click(screen.getByTestId("thinking-block-peek"));
    expect(screen.getByTestId("thinking-block-peek")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Visible plan")).toBeVisible();
  });

  it("keeps a shown block readable after switching to a Hidden model", async () => {
    const { user, store } = await renderWithProviders(
      <ThinkingBlockPeek content="Earlier plan" index={0} prevItem={null} />,
    );
    await selectHiddenModel(store);
    await user.click(screen.getByTestId("thinking-block-peek"));
    expect(screen.getByText("Earlier plan")).toBeInTheDocument();
  });

  it("is open while the model thinks and collapses when thinking ends", async () => {
    const { rerender } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Working it out"
        index={0}
        prevItem={null}
        inProgress
      />,
    );
    const peek = screen.getByTestId("thinking-block-peek");
    expect(peek).toHaveTextContent("Thinking");
    expect(peek).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Working it out")).toBeVisible();

    await act(async () => {
      rerender(
        <ThinkingBlockPeek
          content="Working it out"
          index={0}
          prevItem={null}
          inProgress={false}
        />,
      );
    });
    expect(peek).toHaveAttribute("aria-expanded", "false");
    expect(peek).toHaveTextContent(/^Thought \d+s$/);
    expect(screen.queryByText("Working it out")).not.toBeInTheDocument();
  });

  it("keeps a block the user toggled while thinking in that state", async () => {
    const { user, rerender } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Draft"
        index={0}
        prevItem={null}
        inProgress
      />,
    );
    // Close, then reopen by hand during streaming
    await user.click(screen.getByTestId("thinking-block-peek"));
    await user.click(screen.getByTestId("thinking-block-peek"));

    await act(async () => {
      rerender(
        <ThinkingBlockPeek
          content="Draft"
          index={0}
          prevItem={null}
          inProgress={false}
        />,
      );
    });
    expect(screen.getByTestId("thinking-block-peek")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Draft")).toBeVisible();
  });

  it("is a plain text row with the reasoning in the muted color", async () => {
    const { user } = await renderWithProviders(
      <ThinkingBlockPeek content="Muted plan" index={0} prevItem={null} />,
    );
    const peek = screen.getByTestId("thinking-block-peek");
    expect(peek.className).not.toMatch(/rounded-full|border-solid/);
    // Same size as the reasoning and answers, not a smaller caption
    expect(peek).toHaveStyle({ fontSize: "14px" });
    expect(peek.className).not.toMatch(/text-xs/);

    await user.click(peek);
    const content = screen.getByTestId("thinking-block-content");
    // No inner scroll box: the reasoning takes its full height
    expect(content.className).not.toMatch(/overflow-y-auto|max-h-/);
    const markdown = content.querySelector('[data-muted="true"]')!;
    const noSpaces = (v: string) => v.replace(/\s/g, "");
    expect(noSpaces(getComputedStyle(markdown).color)).toBe(
      noSpaces(varWithFallback("description")),
    );
  });
});
