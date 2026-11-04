import { LLMOptions } from "../../index.js";

import OpenAI from "./OpenAI.js";

class Groq extends OpenAI {
  static providerName = "groq";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.groq.com/openai/v1/",
  };
  maxStopWords: number | undefined = 4;
}

export default Groq;
