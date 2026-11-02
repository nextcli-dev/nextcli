import { describe, expect, it, vi } from "vitest";

import { testIde } from "../test/fixtures.js";
import { IProfileLoader } from "./profile/IProfileLoader.js";
import { ProfileLifecycleManager } from "./ProfileLifecycleManager.js";

function makeLoader(doLoadConfig: IProfileLoader["doLoadConfig"]) {
  const loader: IProfileLoader = {
    description: {
      fullSlug: { ownerSlug: "", packageSlug: "", versionSlug: "" },
      title: "Main Config",
      id: "local",
      iconUrl: "",
      errors: undefined,
      uri: "file:///home/user/.continue/config.yaml",
    },
    doLoadConfig,
    setIsActive: vi.fn(),
  };
  return loader;
}

describe("ProfileLifecycleManager", () => {
  it("records a thrown load error on the profile description", async () => {
    const loader = makeLoader(
      vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Failed to parse config: Implicit keys need to be on a single line",
          ),
        ),
    );
    const manager = new ProfileLifecycleManager(loader, testIde);

    const result = await manager.reloadConfig();

    expect(result.config).toBeUndefined();
    expect(result.configLoadInterrupted).toBe(true);
    expect(result.errors?.[0].fatal).toBe(true);
    expect(manager.profileDescription.errors).toEqual(result.errors);
    expect(manager.profileDescription.errors?.[0].message).toContain(
      "Failed to parse config",
    );
  });
});
