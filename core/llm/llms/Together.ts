import OpenAI from "./OpenAI.js";

import type { CompletionOptions, LLMOptions } from "../../index.js";

class Together extends OpenAI {
  static providerName = "together";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.together.xyz/v1/",
  };

  protected async *_streamComplete(
    prompt: string,
    signal: AbortSignal,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    for await (const chunk of this._legacystreamComplete(
      prompt,
      signal,
      options,
    )) {
      yield chunk;
    }
  }
}

export default Together;
