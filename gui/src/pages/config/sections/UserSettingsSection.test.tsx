import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { updateConfig } from "../../../redux/slices/configSlice";
import { renderWithProviders } from "../../../util/test/render";
import { UserSettingsSection } from "./UserSettingsSection";

// The switch next to the "Allow Anonymous Telemetry" title
function telemetrySwitch() {
  let row: HTMLElement | null = screen.getByText("Allow Anonymous Telemetry");
  while (row && !row.querySelector(".rounded-full.border-solid")) {
    row = row.parentElement;
  }
  const track = row!.querySelector(".rounded-full.border-solid") as HTMLElement;
  const knob = track.firstElementChild as HTMLElement;
  return { track, isOn: () => knob.className.includes("brightness-150") };
}

async function renderWithStoredOptIn(allowAnonymousTelemetry: boolean) {
  const rendered = await renderWithProviders(<UserSettingsSection />);
  await act(async () => {
    rendered.store.dispatch(
      updateConfig({
        ...rendered.store.getState().config.config,
        allowAnonymousTelemetry,
      }),
    );
  });
  const post = vi.spyOn(rendered.ideMessenger, "post");
  return { ...rendered, post };
}

describe("Allow Anonymous Telemetry switch", () => {
  it("shows a stored opt-in as on, and turning it off saves false", async () => {
    const { user, post } = await renderWithStoredOptIn(true);
    const toggle = telemetrySwitch();
    expect(toggle.isOn()).toBe(true);

    await user.click(toggle.track);

    expect(post).toHaveBeenCalledWith("config/updateSharedConfig", {
      allowAnonymousTelemetry: false,
    });
    expect(telemetrySwitch().isOn()).toBe(false);
  });

  it("shows no opt-in as off, and turning it on saves true", async () => {
    const { user, post } = await renderWithStoredOptIn(false);
    const toggle = telemetrySwitch();
    expect(toggle.isOn()).toBe(false);

    await user.click(toggle.track);

    expect(post).toHaveBeenCalledWith("config/updateSharedConfig", {
      allowAnonymousTelemetry: true,
    });
    expect(telemetrySwitch().isOn()).toBe(true);
  });
});
