import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("keeps live reasoning in a bounded box that the user can open in full", async () => {
    const { user } = await renderWithProviders(
      <ThinkingBlockPeek
        content="Long reasoning"
        index={0}
        prevItem={null}
        inProgress
      />,
    );
    // While the model thinks: a bounded box, so the chat doesn't grow
    const live = screen.getByTestId("thinking-block-live");
    expect(live.className).toMatch(/max-h-\[50vh\]/);
    expect(live).toHaveTextContent("Long reasoning");

    // Opened by hand: full height
    await user.click(screen.getByTestId("thinking-block-peek"));
    await user.click(screen.getByTestId("thinking-block-peek"));
    expect(screen.queryByTestId("thinking-block-live")).not.toBeInTheDocument();
    expect(screen.getByText("Long reasoning")).toBeVisible();
  });

  it("follows the end of live reasoning until the user scrolls up", async () => {
    await renderWithProviders(
      <ThinkingBlockPeek
        content="Long reasoning"
        index={0}
        prevItem={null}
        inProgress
      />,
    );
    const box = screen.getByTestId("thinking-block-live");
    const content = box.firstElementChild!;
    // jsdom has no layout: give the box sizes, and find the observer that
    // watches its content (renderWithProviders mocks ResizeObserver)
    let scrollHeight = 1000;
    Object.defineProperty(box, "scrollHeight", { get: () => scrollHeight });
    Object.defineProperty(box, "clientHeight", { value: 100 });
    Object.defineProperty(box, "scrollTop", { value: 0, writable: true });
    const RO = vi.mocked(global.ResizeObserver);
    const index = RO.mock.results.findIndex((r) =>
      vi
        .mocked(r.value.observe)
        .mock.calls.some(([target]: [Element]) => target === content),
    );
    const grow = (height: number) => {
      scrollHeight = height;
      (RO.mock.calls[index][0] as ResizeObserverCallback)([], {} as any);
    };

    grow(1000);
    expect(box.scrollTop).toBe(1000);

    // The user scrolls up to read: new text doesn't pull them down
    box.scrollTop = 200;
    fireEvent.scroll(box);
    grow(1500);
    expect(box.scrollTop).toBe(200);

    // Back at the end: following resumes
    box.scrollTop = 1400;
    fireEvent.scroll(box);
    grow(2000);
    expect(box.scrollTop).toBe(2000);
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
    // The size of the tool call rows (2px under the 14px setting), and it
    // follows the setting rather than a fixed text-xs
    expect(peek).toHaveStyle({ fontSize: "12px" });
    expect(peek.className).not.toMatch(/text-xs/);

    await user.click(peek);
    const content = screen.getByTestId("thinking-block-content");
    // No inner scroll box: the reasoning takes its full height
    expect(content.className).not.toMatch(/overflow-y-auto|max-h-/);
    const markdown = content.querySelector('[data-muted="true"]')!;
    // jsdom lowercases var() names in some computed values (browsers don't);
    // the description and foreground variables differ by more than case
    const normalize = (v: string) => v.replace(/\s/g, "").toLowerCase();
    expect(normalize(getComputedStyle(markdown).color)).toBe(
      normalize(varWithFallback("description")),
    );
    // The reasoning matches its header, not the 14px answers
    expect(getComputedStyle(markdown).fontSize).toBe("12px");
  });
});
