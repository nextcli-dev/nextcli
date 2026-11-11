import { vi } from "vitest";

import { getRunSafetyOptions } from "../tools/runSafetyOptions.js";

import { MCPService } from "./MCPService.js";

import { initializeServices, services } from "./index.js";

describe("initializeServices", () => {
  describe("mode conversion", () => {
    it("should pass only auto flag for auto mode", async () => {
      const spy = vi.spyOn(services.toolPermissions, "initialize");
      await initializeServices({
        headless: true, // Skip onboarding
        toolPermissionOverrides: {
          mode: "auto",
          allow: ["tool1"],
          ask: ["tool2"],
          exclude: ["tool3"],
        },
      });

      expect(spy).toHaveBeenCalledWith(
        {
          allow: ["tool1"],
          ask: ["tool2"],
          exclude: ["tool3"],
          mode: "auto",
          isHeadless: true,
        },
        {
          slug: null,
          agentFile: null,
          agentFileModel: null,
          parsedRules: null,
          parsedTools: null,
        },
        {
          connections: [],
          mcpService: expect.any(MCPService),
          prompts: [],
          tools: [],
        },
      );
    });
  });

  // Every entry point initializes services; the cn review worker passes only
  // config, org and rule, so it must end up with the safe defaults
  describe("run safety options", () => {
    it("takes --pass-env and --allow-private-fetch from the options", async () => {
      await initializeServices({
        headless: true,
        options: { passEnv: ["GH_TOKEN"], allowPrivateFetch: true },
      });
      expect(getRunSafetyOptions()).toEqual({
        passEnv: ["GH_TOKEN"],
        allowPrivateFetch: true,
      });
    });

    it("resets them for a run without the flags", async () => {
      await initializeServices({
        headless: true,
        options: { passEnv: ["GH_TOKEN"], allowPrivateFetch: true },
      });
      await initializeServices({ headless: true, options: { rule: [] } });
      expect(getRunSafetyOptions()).toEqual({
        passEnv: [],
        allowPrivateFetch: false,
      });
    });
  });

  // A headless run (-p, cn review) must never check for an update or install
  // one: it should not make network calls or change the global install
  // during an unattended run
  it("tells the update service the run is headless", async () => {
    const spy = vi.spyOn(services.updateService, "initialize");
    await initializeServices({ headless: true });
    expect(spy).toHaveBeenCalledWith(true);
  });
});
