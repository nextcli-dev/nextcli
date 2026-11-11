import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { updateConfig } from "../../redux/slices/configSlice";
import { setInlineErrorMessage } from "../../redux/slices/sessionSlice";
import { EMPTY_ANSWER_PROMPT } from "../../redux/util/noAnswerNotice";
import { renderWithProviders } from "../../util/test/render";
import InlineErrorMessage from "./InlineErrorMessage";

describe("InlineErrorMessage", () => {
  it("asks for the answer after a turn spent its output on thinking", async () => {
    const { store, user, ideMessenger } = await renderWithProviders(
      <InlineErrorMessage />,
    );
    await act(async () => {
      const config = store.getState().config.config;
      store.dispatch(
        updateConfig({
          ...config,
          selectedModelByRole: {
            ...config.selectedModelByRole,
            chat: {
              title: "DeepSeek V4 Pro",
              provider: "deepseek",
              underlyingProviderName: "deepseek",
              model: "deepseek-v4-pro",
            },
          },
        }),
      );
      store.dispatch(
        setInlineErrorMessage({
          kind: "no-answer",
          reason: "length",
          outputTokens: 4096,
        }),
      );
    });

    expect(
      screen.getByText(
        "The model used all its output tokens (4096) before writing an answer. Raise the output limit (maxTokens) for this model.",
      ),
    ).toBeInTheDocument();

    const post = vi.spyOn(ideMessenger, "post");
    await user.click(screen.getByText("Open config"));
    expect(post).toHaveBeenCalledWith("config/openProfile", {
      profileId: undefined,
    });

    await user.click(screen.getByText("Ask for the answer"));
    // The follow-up is submitted as the next user message
    await waitFor(() => {
      const userMessage = store
        .getState()
        .session.history.find((item) => item.message.role === "user");
      expect(userMessage?.editorState).toEqual({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: EMPTY_ANSWER_PROMPT }],
          },
        ],
      });
    });
  });

  it("offers no config link when the stream closed early", async () => {
    const { store, user } = await renderWithProviders(<InlineErrorMessage />);
    await act(async () => {
      store.dispatch(
        setInlineErrorMessage({ kind: "no-answer", reason: "incomplete" }),
      );
    });
    expect(screen.queryByText("Open config")).not.toBeInTheDocument();

    await user.click(screen.getByText("Hide"));
    expect(store.getState().session.inlineErrorMessage).toBeUndefined();
  });
});
