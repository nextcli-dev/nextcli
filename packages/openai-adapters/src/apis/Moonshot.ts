import { ChatCompletionCreateParams } from "openai/resources/index";
import { MoonshotConfig } from "../types.js";
import { addEmptyReasoningContent } from "../util.js";
import { OpenAIApi } from "./OpenAI.js";

/** International platform; China keys need `https://api.moonshot.cn/v1/` */
export const MOONSHOT_API_BASE = "https://api.moonshot.ai/v1/";

/**
 * Moonshot (Kimi): OpenAI-compatible. There's no FIM endpoint, so no
 * fimStream; autocomplete goes through chat. Models come from `/v1/models`.
 */
export class MoonshotApi extends OpenAIApi {
  constructor(config: MoonshotConfig) {
    super({
      ...config,
      provider: "openai",
      apiBase: config.apiBase ?? MOONSHOT_API_BASE,
    });
  }

  modifyChatBody<T extends ChatCompletionCreateParams>(body: T): T {
    body = super.modifyChatBody(body);
    // Only Kimi models require reasoning_content (core: llms/Moonshot.ts)
    return body.model.startsWith("kimi")
      ? addEmptyReasoningContent(body)
      : body;
  }
}
