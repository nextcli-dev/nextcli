import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { serviceContainer } from "./ServiceContainer.js";
import { SERVICE_NAMES, UpdateServiceState } from "./types.js";
import { UpdateService } from "./UpdateService.js";

const { getLatestVersion } = vi.hoisted(() => ({
  getLatestVersion: vi.fn(),
}));

// The dev version skips the update check, so pretend to be a release
vi.mock("../version.js", async () => ({
  ...(await vi.importActual<typeof import("../version.js")>("../version.js")),
  getVersion: () => "0.1.0",
  getLatestVersion,
}));

vi.mock("core/util/GlobalContext.js", () => ({
  GlobalContext: class {
    get() {
      return undefined;
    }
    update() {}
  },
}));

vi.mock("src/util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Lets timers and promise continuations that the service started finish
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The update check is skipped when NODE_ENV is "test", which hid this bug from
// the TUI tests: the real check ran only in the published CLI.
describe("UpdateService startup", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTCLI_VERSION_INFO_URL", "");
    // Stops an available update from being installed and the CLI restarted
    vi.stubEnv("CONTINUE_CLI_AUTO_UPDATED", "true");
    getLatestVersion.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // The CLI hid its input box forever and exited: initialization returned the
  // "checking" snapshot over the "idle" state the finished check had just set
  it("is idle, not stuck on checking, when no update endpoint is configured", async () => {
    getLatestVersion.mockResolvedValue(null);
    const service = new UpdateService();

    await service.initialize(false);
    await settle();

    expect(service.getState().status).toBe("idle");
    expect(service.getState().message).toBe("NextCLI CLI");
  });

  it("does not look up a latest version when no endpoint is configured", async () => {
    const service = new UpdateService();

    await service.initialize(false);
    await settle();

    expect(getLatestVersion).not.toHaveBeenCalled();
  });

  it("keeps the result of a check that finishes immediately", async () => {
    vi.stubEnv("NEXTCLI_VERSION_INFO_URL", "https://example.com/version.json");
    getLatestVersion.mockResolvedValue("0.1.0");
    const service = new UpdateService();

    await service.initialize(false);
    await settle();

    expect(service.getState()).toMatchObject({
      status: "idle",
      latestVersion: "0.1.0",
      isUpdateAvailable: false,
    });
  });

  it("reports an available update", async () => {
    vi.stubEnv("NEXTCLI_VERSION_INFO_URL", "https://example.com/version.json");
    getLatestVersion.mockResolvedValue("9.9.9");
    const service = new UpdateService();

    await service.initialize(false);
    await settle();

    expect(service.getState()).toMatchObject({
      status: "idle",
      latestVersion: "9.9.9",
      isUpdateAvailable: true,
      message: "Update available: v9.9.9",
    });
  });

  it("never checks in headless mode", async () => {
    vi.stubEnv("NEXTCLI_VERSION_INFO_URL", "https://example.com/version.json");
    const service = new UpdateService();

    await service.initialize(true);
    await settle();

    expect(getLatestVersion).not.toHaveBeenCalled();
    expect(service.getState().status).toBe("idle");
  });
});

// The TUI reads update state from the service container, not from the service
// object: the input box is hidden while the container says "checking"
describe("update state seen by the UI", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXTCLI_VERSION_INFO_URL", "");
    getLatestVersion.mockReset();
    getLatestVersion.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is not left on checking when the service is loaded the way the CLI loads it", async () => {
    const service = new UpdateService();
    serviceContainer.register(SERVICE_NAMES.UPDATE, () =>
      service.initialize(false),
    );

    await serviceContainer.load(SERVICE_NAMES.UPDATE);
    await settle();

    const { value } = serviceContainer.getSync<UpdateServiceState>(
      SERVICE_NAMES.UPDATE,
    );
    expect(value?.status).toBe("idle");
  });
});
