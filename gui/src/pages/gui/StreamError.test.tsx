import { screen } from "@testing-library/react";
import { CONFIG_NOT_LOADED_MESSAGE } from "core/config/chatModel";
import { describe, expect, it } from "vitest";

import { renderWithProviders } from "../../util/test/render";
import StreamErrorDialog from "./StreamError";

describe("StreamErrorDialog", () => {
  it("keeps the config error body when the message also matches an HTTP hint", async () => {
    await renderWithProviders(
      <StreamErrorDialog
        error={
          new Error(`${CONFIG_NOT_LOADED_MESSAGE}: the provider is overloaded`)
        }
      />,
    );

    expect(screen.getByText("Config failed to load")).toBeTruthy();
    expect(screen.getByText(/Your config failed to load/)).toBeTruthy();
    expect(screen.queryByText(/server\(s\) are overloaded/)).toBeNull();
  });

  it("shows the HTTP hint for a normal error", async () => {
    await renderWithProviders(
      <StreamErrorDialog error={new Error("the provider is overloaded")} />,
    );

    expect(screen.getByText("Error handling model response")).toBeTruthy();
    expect(screen.getByText(/server\(s\) are overloaded/)).toBeTruthy();
  });
});
