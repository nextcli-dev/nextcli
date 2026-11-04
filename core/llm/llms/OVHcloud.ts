import { LLMOptions } from "../../index.js";
import OpenAI from "./OpenAI.js";

export class OVHcloud extends OpenAI {
  static providerName = "ovhcloud";

  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/",
    model: "Qwen2.5-Coder-32B-Instruct",
    useLegacyCompletionsEndpoint: false,
  };
}

export default OVHcloud;
