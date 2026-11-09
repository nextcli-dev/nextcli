import fs from "fs";
import path from "path";

import YAML from "yaml";

import { env } from "../env.js";
import { logger } from "../util/logger.js";

import { patternListsToPolicies, ToolPatternError } from "./toolPattern.js";
import { ToolPermissionPolicy } from "./types.js";

export const PERMISSIONS_YAML_PATH = path.resolve(
  path.join(env.continueHome, "permissions.yaml"),
);

export interface PermissionsYamlConfig {
  allow?: string[];
  ask?: string[];
  exclude?: string[];
}

/**
 * Loads permissions from ~/.continue/permissions.yaml
 * Returns null if file doesn't exist or can't be parsed
 */
export function loadPermissionsYaml(): PermissionsYamlConfig | null {
  try {
    if (!fs.existsSync(PERMISSIONS_YAML_PATH)) {
      logger.debug("Permissions YAML file does not exist", {
        path: PERMISSIONS_YAML_PATH,
      });
      return null;
    }

    const content = fs.readFileSync(PERMISSIONS_YAML_PATH, "utf-8");
    const parsed = YAML.parse(content) as PermissionsYamlConfig;

    // Validate the structure
    if (parsed && typeof parsed === "object") {
      const validKeys = ["allow", "ask", "exclude"];
      const hasValidStructure = Object.keys(parsed).every(
        (key) =>
          validKeys.includes(key) &&
          (!parsed[key as keyof PermissionsYamlConfig] ||
            Array.isArray(parsed[key as keyof PermissionsYamlConfig])),
      );

      if (hasValidStructure) {
        logger.debug("Loaded permissions from YAML", {
          allow: parsed.allow?.length || 0,
          ask: parsed.ask?.length || 0,
          exclude: parsed.exclude?.length || 0,
        });
        return parsed;
      }
    }

    logger.warn("Invalid permissions YAML structure", {
      path: PERMISSIONS_YAML_PATH,
    });
    return null;
  } catch (error) {
    logger.error("Failed to load permissions YAML", {
      error,
      path: PERMISSIONS_YAML_PATH,
    });
    return null;
  }
}

/**
 * Converts permissions YAML config to ToolPermissionPolicy array
 */
export function yamlConfigToPolicies(
  config: PermissionsYamlConfig,
): ToolPermissionPolicy[] {
  try {
    // Order matters: more restrictive policies first
    return patternListsToPolicies(config);
  } catch (error) {
    if (error instanceof ToolPatternError) {
      throw new ToolPatternError(`${PERMISSIONS_YAML_PATH}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Creates the permissions.yaml file with default content if it doesn't exist
 */
export async function ensurePermissionsYamlExists(): Promise<void> {
  const dir = path.dirname(PERMISSIONS_YAML_PATH);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  // Create file if it doesn't exist
  if (!fs.existsSync(PERMISSIONS_YAML_PATH)) {
    const defaultContent = `# cn tool permissions

# Tools that are automatically allowed without prompting
allow: []

# Tools that require user confirmation before execution
ask: []

# Tools that are completely excluded (model won't know they exist)
exclude: []
`;

    await fs.promises.writeFile(PERMISSIONS_YAML_PATH, defaultContent, "utf-8");
    logger.info("Created default permissions.yaml", {
      path: PERMISSIONS_YAML_PATH,
    });
  }
}
