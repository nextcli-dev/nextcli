import OpenAI from "./OpenAI.js";

import type { CompletionOptions, LLMOptions } from "../../index.js";

class Novita extends OpenAI {
  static providerName = "novita";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.novita.ai/v3/openai/",
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

export default Novita;
