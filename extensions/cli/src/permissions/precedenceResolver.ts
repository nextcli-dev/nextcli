import { getDefaultToolPolicies } from "./defaultPolicies.js";
import {
  commandLineFlagsToPolicies,
  headlessKeepsYamlPolicy,
} from "./flagPolicies.js";
import {
  loadPermissionsYaml,
  yamlConfigToPolicies,
} from "./permissionsYamlLoader.js";
import { type ToolPermissionPolicy } from "./types.js";

export interface PermissionSources {
  /** Command line flags - highest precedence */
  commandLineFlags?: {
    allow?: string[];
    ask?: string[];
    exclude?: string[];
  };
  /** ~/.continue/permissions.yaml - third precedence */
  personalSettings?: boolean; // Whether to load from permissions.yaml
  /** Default policies - lowest precedence */
  isHeadless?: boolean;
  useDefaults?: boolean;
}

/**
 * Resolves permission policies from all sources according to precedence rules.
 * This function implements the clean precedence logic from the specification:
 *
 * 1. Command line flags (highest)
 * 2. Permissions in config.yaml (when implemented)
 * 3. Permissions in ~/.continue/permissions.yaml
 * 4. Default policies (lowest)
 *
 * Earlier sources completely override later ones on a per-tool basis.
 *
 * In a headless run, permissions.yaml keeps its excludes and the safe
 * remembered allows (`headlessKeepsYamlPolicy`): a scoped pattern such as
 * `Bash(ls*)`, or a whole tool headless does not close, such as `Write`.
 * Asks are dropped, and so are whole-tool Bash, Fetch, `*`, and MCP names,
 * which would reopen the shell or the network. The file is per machine, so
 * an exclude written for the terminal also removes that tool from `cn -p`.
 * Use --allow to opt a headless run in to anything the file does not keep.
 */
export function resolvePermissionPrecedence(
  sources: PermissionSources,
): ToolPermissionPolicy[] {
  const policies: ToolPermissionPolicy[] = [];

  // Layer 1: Command line flags (highest precedence)
  if (sources.commandLineFlags) {
    const cliPolicies = commandLineFlagsToPolicies(sources.commandLineFlags);
    policies.push(...cliPolicies);
  }

  // Layer 2: Personal settings from ~/.continue/permissions.yaml
  if (sources.personalSettings !== false) {
    const yamlConfig = loadPermissionsYaml();
    if (yamlConfig) {
      const yamlPolicies = yamlConfigToPolicies(yamlConfig);
      policies.push(
        ...(sources.isHeadless
          ? yamlPolicies.filter(headlessKeepsYamlPolicy)
          : yamlPolicies),
      );
    }
  }

  // Layer 3: Default policies (lowest precedence)
  if (sources.useDefaults !== false) {
    const defaultPolicies = getDefaultToolPolicies(sources.isHeadless);
    policies.push(...defaultPolicies);
  }

  return policies;
}
