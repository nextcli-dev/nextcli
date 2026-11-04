import { LLMOptions } from "../../index.js";

import OpenAI from "./OpenAI.js";

class FunctionNetwork extends OpenAI {
  static providerName = "function-network";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.function.network/v1/",
    model: "meta/llama-3.1-70b-instruct",
    maxEmbeddingBatchSize: 128,
  };

  constructor(options: LLMOptions) {
    super(options);
  }

  public supportsFim(): boolean {
    return false;
  }

  public supportsCompletions(): boolean {
    return false;
  }

  public supportsPrefill(): boolean {
    return false;
  }

  protected async _embed(chunks: string[]): Promise<number[][]> {
    const resp = await this.fetch(new URL("embeddings", this.apiBase), {
      method: "POST",
      body: JSON.stringify({
        input: chunks,
        model: this.model,
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

export default FunctionNetwork;
