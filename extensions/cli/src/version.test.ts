import { afterEach, describe, expect, it, vi } from "vitest";

describe("version", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // Headless runs (-p, cn review) never check for updates; only the update
  // service, started in an interactive run, asks for the latest version
  it("makes no request when the module loads", async () => {
    vi.stubEnv("NEXTCLI_VERSION_INFO_URL", "https://versions.example.invalid");
    const fetch = vi.fn(async () => Response.json({ version: "9.9.9" }));
    vi.stubGlobal("fetch", fetch);
    vi.resetModules();

    const { getLatestVersion } = await import("./version.js");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();

    expect(await getLatestVersion()).toBe("9.9.9");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
