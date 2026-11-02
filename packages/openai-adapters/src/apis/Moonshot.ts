import { streamSse } from "@nextcli/fetch";
import {
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  Model,
} from "openai/resources/index";
import { MoonshotConfig } from "../types.js";
import { addEmptyReasoningContent, chatChunk, customFetch } from "../util.js";
import { OpenAIApi } from "./OpenAI.js";
import { FimCreateParamsStreaming } from "./base.js";

export class MoonshotApi extends OpenAIApi {
  apiBase: string = "https://api.moonshot.cn/";
  constructor(config: MoonshotConfig) {
    super({
      ...config,
      provider: "openai",
    });
  }

  modifyChatBody<T extends ChatCompletionCreateParams>(body: T): T {
    body = super.modifyChatBody(body);
    // Only Kimi models require reasoning_content (core: llms/Moonshot.ts)
    return body.model.startsWith("kimi")
      ? addEmptyReasoningContent(body)
      : body;
  }

  async *fimStream(
    body: FimCreateParamsStreaming,
    signal: AbortSignal,
  ): AsyncGenerator<ChatCompletionChunk, any, unknown> {
    const endpoint = new URL("v1/chat/completions", this.apiBase);
    const resp = await customFetch(this.config.requestOptions)(endpoint, {
      method: "POST",
      body: JSON.stringify({
        model: body.model,
        messages: [
          {
            role: "user",
            content: body.prompt + "[fill]" + body.suffix,
          },
        ],
        max_tokens: body.max_tokens,
        temperature: body.temperature,
        top_p: body.top_p,
        frequency_penalty: body.frequency_penalty,
        presence_penalty: body.presence_penalty,
        stop: body.stop,
        stream: true,
      }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      signal,
    });

    for await (const chunk of streamSse(resp as any)) {
      yield chatChunk({
        content: chunk.choices[0].delta.content,
        finish_reason: chunk.finish_reason,
        model: body.model,
      });
    }
  }
  list(): Promise<Model[]> {
    throw new Error("Method not implemented.");
  }
}
