import { screen, waitFor } from "@testing-library/dom";
import { act } from "@testing-library/react";
import { renderWithProviders } from "../../util/test/render";
import StyledMarkdownPreview from "./index";

afterEach(() => {
  vi.restoreAllMocks();
});

test("renders an empty message without errors, then its streamed text", async () => {
  const consoleError = vi.spyOn(console, "error");

  const { rerender } = await renderWithProviders(
    <StyledMarkdownPreview source="" isRenderingInStepContainer />,
  );
  // Let the async markdown pipeline settle on the empty source
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  rerender(
    <StyledMarkdownPreview
      source="The answer arrives **later**."
      isRenderingInStepContainer
    />,
  );

  await waitFor(() => expect(screen.getByText("later")).toBeInTheDocument());
  expect(consoleError).not.toHaveBeenCalledWith(
    "Failed to render markdown",
    expect.anything(),
  );
});
