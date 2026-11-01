import * as fs from "fs";
import * as path from "path";

import chalk from "chalk";
import { setConfigFilePermissions } from "core/util/paths.js";
import { parse } from "yaml";

import type { AuthConfig } from "./auth/workos.js";
import { getApiClient } from "./config.js";
import { loadConfiguration } from "./configLoader.js";
import { env } from "./env.js";
import { resolveEnvProviderConfig } from "./util/envProviderConfig.js";
import { question, questionWithChoices } from "./util/prompt.js";
import {
  getProviderPreset,
  PROVIDER_PRESETS,
  type ProviderPreset,
  type ProviderPresetOptions,
} from "./util/providerPresets.js";
import { upsertProviderModelsInYaml } from "./util/yamlConfigUpdater.js";

const CONFIG_PATH = path.join(env.continueHome, "config.yaml");

/** True when the config file exists and defines at least one model */
export async function checkHasAcceptableModel(
  configPath: string,
): Promise<boolean> {
  try {
    if (!fs.existsSync(configPath)) {
      return false;
    }

    const config = parse(fs.readFileSync(configPath, "utf8"));
    return Array.isArray(config?.models) && config.models.length > 0;
  } catch {
    return false;
  }
}

export async function createOrUpdateProviderConfig(
  preset: ProviderPreset,
  options: ProviderPresetOptions,
): Promise<void> {
  const configDir = path.dirname(CONFIG_PATH);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const existingContent = fs.existsSync(CONFIG_PATH)
    ? fs.readFileSync(CONFIG_PATH, "utf8")
    : "";

  const updatedContent = upsertProviderModelsInYaml(
    existingContent,
    preset,
    options,
  );
  fs.writeFileSync(CONFIG_PATH, updatedContent);
  setConfigFilePermissions(CONFIG_PATH);
}

export async function createOrUpdateConfig(apiKey: string): Promise<void> {
  await createOrUpdateProviderConfig(getProviderPreset("anthropic")!, {
    apiKey,
  });
}

async function promptForProvider(): Promise<ProviderPreset> {
  console.log(chalk.yellow("To get started, choose a model provider:"));
  PROVIDER_PRESETS.forEach((preset, i) => {
    console.log(chalk.white(`  ${i + 1}. ${preset.label}`));
  });
  const choices = PROVIDER_PRESETS.map((_, i) => String(i + 1));
  const answer = await questionWithChoices(
    chalk.white(`\nEnter a number (1-${PROVIDER_PRESETS.length}) [1]: `),
    choices,
    "1",
    chalk.red(`Please enter a number from 1 to ${PROVIDER_PRESETS.length}.`),
  );
  return PROVIDER_PRESETS[Number(answer) - 1];
}

async function promptForProviderOptions(
  preset: ProviderPreset,
): Promise<ProviderPresetOptions> {
  const options: ProviderPresetOptions = {};

  if (preset.needsApiBaseAndModel) {
    options.apiBase = (
      await question(chalk.white("Enter the base URL (e.g. https://host/v1): "))
    ).trim();
    options.model = (
      await question(chalk.white("Enter the model name: "))
    ).trim();
    if (!options.apiBase || !options.model) {
      throw new Error("A base URL and a model name are required");
    }
  } else if (!preset.needsApiKey) {
    const model = (
      await question(
        chalk.white(`Enter the model name [${preset.defaultModel}]: `),
      )
    ).trim();
    options.model = model || undefined;
  }

  if (preset.needsApiKey) {
    const apiKey = (
      await question(chalk.white(`\nEnter your ${preset.label} API key: `))
    ).trim();
    const error = preset.validateApiKey(apiKey);
    if (error) {
      throw new Error(error);
    }
    options.apiKey = apiKey;
  }

  return options;
}

export async function runOnboardingFlow(
  configPath: string | undefined,
): Promise<boolean> {
  // Step 1: Check if --config flag is provided
  if (configPath !== undefined) {
    return false;
  }

  // Step 2: An existing config.yaml with models needs no onboarding (#12258)
  if (await checkHasAcceptableModel(CONFIG_PATH)) {
    return true;
  }

  // Step 3: Check for CONTINUE_USE_BEDROCK environment variable first (before test env check)
  if (process.env.CONTINUE_USE_BEDROCK === "1") {
    console.log(
      chalk.blue("✓ Using AWS Bedrock (CONTINUE_USE_BEDROCK detected)"),
    );
    return true;
  }

  // Step 4: Provider API key env vars are turned into an in-memory config
  // by configLoader, so there is nothing to ask or write
  const envConfig = resolveEnvProviderConfig();
  if (envConfig) {
    console.log(chalk.blue(`✓ Using ${envConfig.source} from environment`));
    return false;
  }

  // Step 5: Check if we're in a test/CI environment - if so, skip interactive prompts
  const isTestEnv =
    process.env.NODE_ENV === "test" ||
    process.env.CI === "true" ||
    process.env.VITEST === "true" ||
    process.env.GITHUB_ACTIONS === "true" ||
    !process.stdin.isTTY;

  if (isTestEnv) {
    return false;
  }

  // Step 6: Ask for a provider and its settings
  const preset = await promptForProvider();
  const options = await promptForProviderOptions(preset);

  await createOrUpdateProviderConfig(preset, options);
  console.log(
    chalk.green(`✓ Config file updated successfully at ${CONFIG_PATH}`),
  );

  return true;
}

export async function isFirstTime(): Promise<boolean> {
  return !fs.existsSync(path.join(env.continueHome, ".onboarding_complete"));
}

export async function markOnboardingComplete(): Promise<void> {
  const flagPath = path.join(env.continueHome, ".onboarding_complete");
  const flagDir = path.dirname(flagPath);

  if (!fs.existsSync(flagDir)) {
    fs.mkdirSync(flagDir, { recursive: true });
  }

  fs.writeFileSync(flagPath, new Date().toISOString());
}

export async function initializeWithOnboarding(
  authConfig: AuthConfig,
  configPath: string | undefined,
) {
  const firstTime = await isFirstTime();

  if (configPath !== undefined) {
    // throw an early error is configPath is invalid or has errors
    try {
      await loadConfiguration(
        authConfig,
        configPath,
        getApiClient(undefined),
        [],
        false,
      );
    } catch (errorMessage) {
      throw new Error(
        `Failed to load config from "${configPath}": ${errorMessage}`,
      );
    }
  }

  if (!firstTime) return;

  const wasOnboarded = await runOnboardingFlow(configPath);
  if (wasOnboarded) {
    await markOnboardingComplete();
  }
}
