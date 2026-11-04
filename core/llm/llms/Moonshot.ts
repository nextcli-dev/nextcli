import { LLMOptions } from "../../index.js";
import { osModelsEditPrompt } from "../templates/edit.js";

import OpenAI from "./OpenAI.js";

/**
 * Moonshot (Kimi). The international platform is api.moonshot.ai; keys from
 * the China platform (api.moonshot.cn) only work there, so set `apiBase` to
 * `https://api.moonshot.cn/v1/` for those. Moonshot has no FIM endpoint, so
 * autocomplete goes through chat. Models are listed live from `/v1/models`;
 * the V1 models and kimi-k2.5 were retired on 2026-08-31.
 */
class Moonshot extends OpenAI {
  static providerName = "moonshot";

  constructor(options: LLMOptions) {
    super(options);
    this.supportsReasoningContentField =
      this.model?.startsWith("kimi") ?? false;
  }

  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.moonshot.ai/v1/",
    promptTemplates: {
      edit: osModelsEditPrompt,
    },
    useLegacyCompletionsEndpoint: false,
  };
  maxStopWords: number | undefined = 16;
}

export default Moonshot;
