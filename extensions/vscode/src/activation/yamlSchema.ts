import * as vscode from "vscode";

const YAML_EXTENSION_ID = "redhat.vscode-yaml";
const YAML_MATCHER = ".continue/**/*.yaml";
const SCHEMA_FILE = "config-yaml-schema.json";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the new `yaml.schemas` value: schema entries from older versions of
 * this extension removed (the install folder changes with each version) and
 * the current schema added. Entries from other extensions and the user are
 * kept. Returns undefined when nothing would change.
 */
export function mergeYamlSchemas(
  current: Record<string, unknown>,
  newPath: string,
  extensionId: string,
): Record<string, unknown> | undefined {
  const ownSchema = new RegExp(
    `[\\\\/]${escapeRegExp(extensionId.toLowerCase())}-[^\\\\/]+[\\\\/]${escapeRegExp(SCHEMA_FILE)}$`,
    "i",
  );

  const merged: Record<string, unknown> = {};
  let changed = false;
  for (const [key, value] of Object.entries(current)) {
    if (key !== newPath && ownSchema.test(key)) {
      changed = true;
      continue;
    }
    merged[key] = value;
  }

  const existing = merged[newPath];
  if (
    !Array.isArray(existing) ||
    existing.length !== 1 ||
    existing[0] !== YAML_MATCHER
  ) {
    merged[newPath] = [YAML_MATCHER];
    changed = true;
  }

  return changed ? merged : undefined;
}

/**
 * Registers the config.yaml schema with the Red Hat YAML extension. Without
 * that extension `yaml.schemas` is not a registered setting and the write
 * fails (#12948), so it is skipped. If the YAML extension is installed later,
 * the schema is registered on the next activation.
 */
export async function registerYamlSchema(
  context: vscode.ExtensionContext,
): Promise<void> {
  if (!vscode.extensions.getExtension(YAML_EXTENSION_ID)) {
    return;
  }

  try {
    const yamlConfig = vscode.workspace.getConfiguration("yaml");
    const newPath = vscode.Uri.joinPath(
      context.extension.extensionUri,
      SCHEMA_FILE,
    ).toString();
    const schemas = mergeYamlSchemas(
      yamlConfig.get<Record<string, unknown>>("schemas", {}),
      newPath,
      context.extension.id,
    );
    if (schemas) {
      await yamlConfig.update(
        "schemas",
        schemas,
        vscode.ConfigurationTarget.Global,
      );
    }
  } catch (error) {
    console.error("Failed to register the config.yaml schema", error);
  }
}
