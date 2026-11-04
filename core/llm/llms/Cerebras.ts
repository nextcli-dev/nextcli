import { ChatCompletionCreateParams } from "openai/resources/index";
import { ChatMessage, CompletionOptions, LLMOptions } from "../../index.js";

import OpenAI from "./OpenAI.js";

class Cerebras extends OpenAI {
  static providerName = "cerebras";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.cerebras.ai/v1/",
  };
  maxStopWords: number | undefined = 4;

  constructor(options: LLMOptions) {
    super(options);

    // Set context length based on whether the model is the free version
    if (options.model === "qwen-3-coder-480b-free") {
      this._contextLength = 64000;
    } else if (options.model === "qwen-3-coder-480b") {
      this._contextLength = 128000;
    }
  }

  private filterThinkingTags(content: string): string {
    // Remove <thinking>...</thinking> tags (including multiline)
    return content.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  }

  private filterThinkingFromMessages(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => {
      if (typeof message.content === "string") {
        return {
          ...message,
          content: this.filterThinkingTags(message.content),
        } as ChatMessage;
      } else if (Array.isArray(message.content)) {
        return {
          ...message,
          content: message.content.map((part) => {
            if (part.type === "text" && typeof part.text === "string") {
              return {
                ...part,
                text: this.filterThinkingTags(part.text),
              };
            }
            return part;
          }),
        } as ChatMessage;
      }
      return message;
    });
  }

  protected _convertArgs(
    options: CompletionOptions,
    messages: ChatMessage[],
  ): ChatCompletionCreateParams {
    // Filter thinking tags from messages before processing
    const filteredMessages = this.filterThinkingFromMessages(messages);
    return super._convertArgs(options, filteredMessages);
  }
}

export default Cerebras;
