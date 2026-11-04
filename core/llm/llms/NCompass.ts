import { LLMOptions } from "../../index.js";

import OpenAI from "./OpenAI.js";

class NCompass extends OpenAI {
  static providerName = "ncompass";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.ncompass.tech/v1/",
  };
  static embeddingsApiEndpoint = "https://api.gcp.ncompass.tech/v1/embeddings";

  protected _getHeaders() {
    const headers = super._getHeaders() as {
      "Content-Type": string;
      Authorization: string;
      "api-key": string;
      Accept?: string;
    };
    headers["Accept"] = "text/event-stream";
    return headers;
  }

  protected async _embed(chunks: string[]): Promise<number[][]> {
    const resp = await this.fetch(NCompass.embeddingsApiEndpoint, {
      method: "POST",
      body: JSON.stringify({
        input: chunks,
        model: this.model,
        ...this.extraBodyProperties(),
      }),
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!resp.ok) {
      throw new Error(await resp.text());
    }

    const data = (await resp.json()) as any;
    return data.data.map((result: { embedding: number[] }) => result.embedding);
  }
}

export default NCompass;
