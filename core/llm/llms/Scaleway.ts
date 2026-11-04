import OpenAI from "./OpenAI";

import { LLMOptions } from "../../index.js";

class Scaleway extends OpenAI {
  static providerName = "scaleway";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.scaleway.ai/v1/",
    model: "qwen3-coder-30b-a3b-instruct",
    useLegacyCompletionsEndpoint: false,
  };
}

export default Scaleway;
