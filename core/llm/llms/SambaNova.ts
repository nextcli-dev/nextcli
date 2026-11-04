import OpenAI from "./OpenAI.js";

import type { LLMOptions } from "../../index.js";

class SambaNova extends OpenAI {
  static providerName = "sambanova";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.sambanova.ai/v1/",
  };
}

export default SambaNova;
