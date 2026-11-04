import { LLMOptions } from "../../index.js";

import OpenAI from "./OpenAI.js";

class Fireworks extends OpenAI {
  static providerName = "fireworks";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.fireworks.ai/inference/v1/",
  };
}

export default Fireworks;
