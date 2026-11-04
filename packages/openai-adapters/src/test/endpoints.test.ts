import { describe, expect, it } from "vitest";

import { CohereApi } from "../apis/Cohere.js";
import { MoonshotApi } from "../apis/Moonshot.js";

describe("endpoint URLs", () => {
  it("keeps Cohere's version segment in every path", () => {
    for (const apiBase of [
      undefined,
      "https://api.cohere.com/v1",
      "https://api.cohere.com/v1/",
    ]) {
      const api = new CohereApi({ provider: "cohere", apiKey: "k", apiBase });
      expect(new URL("chat", api.apiBase).href).toBe(
        "https://api.cohere.com/v1/chat",
      );
      expect(new URL("embed", api.apiBase).href).toBe(
        "https://api.cohere.com/v1/embed",
      );
    }
  });

  it("defaults Moonshot to the international host and honours apiBase", () => {
    expect(new MoonshotApi({ provider: "moonshot", apiKey: "k" }).apiBase).toBe(
      "https://api.moonshot.ai/v1/",
    );
    expect(
      new MoonshotApi({
        provider: "moonshot",
        apiKey: "k",
        apiBase: "https://api.moonshot.cn/v1/",
      }).apiBase,
    ).toBe("https://api.moonshot.cn/v1/");
  });
});
