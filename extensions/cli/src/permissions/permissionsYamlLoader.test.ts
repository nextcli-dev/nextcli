import { yamlConfigToPolicies } from "./permissionsYamlLoader.js";

describe("permissionsYamlLoader", () => {
  describe("yamlConfigToPolicies", () => {
    it("should convert YAML config to policies with proper order", () => {
      const config = {
        allow: ["Read", "List"],
        ask: ["Write"],
        exclude: ["Bash"],
      };

      const policies = yamlConfigToPolicies(config);

      expect(policies).toEqual([
        { tool: "Bash", permission: "exclude" },
        { tool: "Write", permission: "ask" },
        { tool: "Read", permission: "allow" },
        { tool: "List", permission: "allow" },
      ]);
    });

    it("should use exact tool names without normalization", () => {
      const config = {
        allow: ["read", "READ", "Read"],
      };

      const policies = yamlConfigToPolicies(config);

      expect(policies).toEqual([
        { tool: "read", permission: "allow" },
        { tool: "READ", permission: "allow" },
        { tool: "Read", permission: "allow" },
      ]);
    });

    it("should handle empty config", () => {
      const config = {};

      const policies = yamlConfigToPolicies(config);

      expect(policies).toEqual([]);
    });

    it("should handle wildcard patterns", () => {
      const config = {
        allow: ["external_*"],
        exclude: ["*"],
      };

      const policies = yamlConfigToPolicies(config);

      expect(policies).toEqual([
        { tool: "*", permission: "exclude" },
        { tool: "external_*", permission: "allow" },
      ]);
    });

    it("should handle missing permission types", () => {
      const config = {
        allow: ["Read"],
        // ask and exclude are undefined
      };

      const policies = yamlConfigToPolicies(config);

      expect(policies).toEqual([{ tool: "Read", permission: "allow" }]);
    });

    it("should handle all permission types", () => {
      const config = {
        allow: ["Read", "List"],
        ask: ["Write", "Terminal"],
        exclude: ["Fetch", "Exit"],
      };

      const policies = yamlConfigToPolicies(config);

      expect(policies).toEqual([
        { tool: "Fetch", permission: "exclude" },
        { tool: "Exit", permission: "exclude" },
        { tool: "Write", permission: "ask" },
        { tool: "Terminal", permission: "ask" },
        { tool: "Read", permission: "allow" },
        { tool: "List", permission: "allow" },
      ]);
    });
  });

  it("names the file when a pattern is invalid", () => {
    expect(() => yamlConfigToPolicies({ exclude: ["Write(unclosed"] })).toThrow(
      /permissions\.yaml: Invalid tool pattern: Write\(unclosed/,
    );
  });
});
