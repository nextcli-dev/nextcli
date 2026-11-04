import { ChatCompletionCreateParams } from "@nextcli/openai-adapters";
import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";
import { LlmApiRequestType } from "../openaiTypeConverters.js";

import OpenAI from "./OpenAI.js";

class Azure extends OpenAI {
  static providerName = "azure";

  protected supportsPrediction(model: string): boolean {
    return false;
  }

  protected useOpenAIAdapterFor: (LlmApiRequestType | "*")[] = [];

  static defaultOptions: Partial<LLMOptions> = {
    apiVersion: "2024-02-15-preview",
    apiType: "azure-openai",
  };

  constructor(options: LLMOptions) {
    super(options);
    this.deployment = options.deployment ?? options.model;
  }

  /** Chat requests apply the model menu's effort and thinking off */
  protected supportsModelControls(): boolean {
    return true;
  }

  protected _convertArgs(
    options: CompletionOptions,
    messages: ChatMessage[],
  ): ChatCompletionCreateParams {
    // Only reasoning_effort: Azure's Chat Completions returns no reasoning
    return {
      ...super._convertArgs(options, messages),
      ...this.modelControlFields(options),
    } as ChatCompletionCreateParams;
  }
}

export default Azure;
