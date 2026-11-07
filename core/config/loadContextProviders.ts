import {
  AssistantUnrolledNonNullable,
  ConfigValidationError,
} from "@nextcli/config-yaml";
import { IContextProvider } from "..";
import { contextProviderClassFromName } from "../context/providers";
import CurrentFileContextProvider from "../context/providers/CurrentFileContextProvider";
import DiffContextProvider from "../context/providers/DiffContextProvider";
import FileContextProvider from "../context/providers/FileContextProvider";
import ProblemsContextProvider from "../context/providers/ProblemsContextProvider";
import RulesContextProvider from "../context/providers/RulesContextProvider";
import TerminalContextProvider from "../context/providers/TerminalContextProvider";

export const REMOVED_DOCS_PROVIDER_MESSAGE =
  "The `docs` context provider was removed with @docs and is ignored. Use the fetch tool or a docs MCP server instead.";

export const REMOVED_DOCS_BLOCK_MESSAGE =
  "The `docs` config block was removed with @docs and is ignored. Use the fetch tool or a docs MCP server instead.";

export function removedEmbedRoleMessage(modelName: string): string {
  return `Model "${modelName}" has the \`embed\` role, which is ignored: NextCLI no longer computes embeddings. @codebase and @folder use keyword search.`;
}

/*
    Loads context providers based on configuration
    - default providers will always be loaded, using config params if present
    - other providers will be loaded if configured

    NOTE the MCPContextProvider is added in doLoadConfig if any resources are present
*/
export function loadConfigContextProviders(
  configContext: AssistantUnrolledNonNullable["context"],
): {
  providers: IContextProvider[];
  errors: ConfigValidationError[];
} {
  const providers: IContextProvider[] = [];
  const errors: ConfigValidationError[] = [];

  const defaultProviders: IContextProvider[] = [
    new FileContextProvider({}),
    new CurrentFileContextProvider({}),
    new DiffContextProvider({}),
    new TerminalContextProvider({}),
    new ProblemsContextProvider({}),
    new RulesContextProvider({}),
  ];

  // Add from config
  if (configContext) {
    for (const config of configContext) {
      if (config.provider === "docs") {
        errors.push({
          fatal: false,
          message: REMOVED_DOCS_PROVIDER_MESSAGE,
        });
        continue;
      }
      const cls = contextProviderClassFromName(config.provider) as any;
      if (
        !cls &&
        !defaultProviders.find((p) => p.description.title === config.provider)
      ) {
        errors.push({
          fatal: false,
          message: `Unknown context provider ${config.provider}`,
        });
        continue;
      }
      providers.push(
        new cls({
          name: config.name,
          ...config.params,
        }),
      );
    }
  }

  // Add from defaults if not found in config
  for (const defaultProvider of defaultProviders) {
    if (
      !providers.find(
        (p) => p.description.title === defaultProvider.description.title,
      )
    ) {
      providers.push(defaultProvider);
    }
  }

  return {
    providers,
    errors,
  };
}
