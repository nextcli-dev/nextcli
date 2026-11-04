import ReplicateClient from "replicate";

import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";
import { renderChatMessage } from "../../util/messageContent.js";
import { BaseLLM } from "../index.js";

class Replicate extends BaseLLM {
  static providerName = "replicate";
  private _replicate: ReplicateClient;

  private _convertArgs(
    options: CompletionOptions,
    prompt: string,
    signal: AbortSignal,
  ): [`${string}/${string}:${string}`, { input: any }] {
    return [
      options.model as `${string}/${string}:${string}`,
      {
        input: { prompt, message: prompt },
      },
    ];
  }

  private _convertChatArgs(
    options: CompletionOptions,
    messages: ChatMessage[],
    signal: AbortSignal,
  ): [`${string}/${string}:${string}`, { input: any }] {
    let prompt = "";
    let system_prompt = "";

    for (const message of messages) {
      const content =
        typeof message.content === "string"
          ? message.content
          : renderChatMessage(message);

      if (message.role === "system") {
        system_prompt += `System: ${content}\n\n`;
      } else if (message.role === "user") {
        prompt += `Human: ${content}\n\n`;
      } else if (message.role === "assistant") {
        prompt += `Assistant: ${content}\n\n`;
      }
    }

    if (!prompt.endsWith("Assistant: ")) {
      prompt += "Assistant: ";
    }

    // Construct the input
    const input: any = {
      prompt: prompt,
      system_prompt: system_prompt,
      max_tokens: options.maxTokens || 2048,
      extended_thinking: options.reasoning,
      thinking_budget_tokens: options.reasoningBudgetTokens || 1024,
    };

    return [
      options.model as `${string}/${string}:${string}`,
      {
        input,
      },
    ];
  }

  constructor(options: LLMOptions) {
    super(options);
    this._replicate = new ReplicateClient({ auth: options.apiKey });
  }

  protected async _complete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): Promise<string> {
    const [model, args] = this._convertArgs(options, prompt, signal);
    const response = await this._replicate.run(model, args);

    return (response as any)[0];
  }

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    const [model, args] = this._convertArgs(options, prompt, signal);
    for await (const event of this._replicate.stream(model, args)) {
      if (event.event === "output") {
        yield event.data;
      }
    }
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    if (!this.apiKey || this.apiKey === "") {
      throw new Error("You need to use an API key");
    }

    const [model, args] = this._convertChatArgs(options, messages, signal);

    try {
      for await (const event of this._replicate.stream(model, args)) {
        if (event.event === "output") {
          yield {
            role: "assistant",
            content: event.data,
          };
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes("authentication")) {
          throw new Error(
            "Replicate API authentication failed. Please check your API key",
          );
        }
        if (error.message.includes("model not found")) {
          throw new Error(
            `Model "${options.model}" not found on Replicate. Please check the model name or use another model.`,
          );
        }
      }
      throw error;
    }
  }
}

export default Replicate;
