import { AllMediaTypes, ModelProvider } from "../types.js";

// See https://ai.google.dev/gemini-api/docs/models
export const Gemini: ModelProvider = {
  models: [
    // Current models (ids from ai.google.dev/gemini-api/docs/models, 2026-11-04).
    // Context and output limits are left unset until confirmed from the docs.
    {
      model: "gemini-4-argon",
      displayName: "Gemini 4 Argon",
      mediaTypes: AllMediaTypes,
      regex: /^(?:models\/)?gemini-4-argon/i,
      recommendedFor: ["chat"],
    },
    {
      model: "gemini-3.8-flash",
      displayName: "Gemini 3.8 Flash",
      mediaTypes: AllMediaTypes,
      regex: /^(?:models\/)?gemini-3\.8-flash(?!-lite)/i,
      recommendedFor: ["chat"],
    },
    {
      model: "gemini-3.6-flash",
      displayName: "Gemini 3.6 Flash",
      mediaTypes: AllMediaTypes,
      regex: /^(?:models\/)?gemini-3\.6-flash(?!-lite)/i,
      recommendedFor: ["chat"],
    },
    {
      model: "gemini-3.5-flash-lite",
      displayName: "Gemini 3.5 Flash Lite",
      mediaTypes: AllMediaTypes,
      regex: /^(?:models\/)?gemini-3\.5-flash-lite/i,
      recommendedFor: ["chat"],
    },
    // Gemini 3.1 series
    {
      model: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro Preview",
      description:
        "Google's most capable model with 2M context window and high precision multimodal capabilities.",
      contextLength: 2097152,
      maxCompletionTokens: 65536,
      mediaTypes: AllMediaTypes,
      regex: /gemini-3\.1-pro-preview/i,
      recommendedFor: ["chat"],
    },
    {
      model: "gemini-3.1-flash-image-preview",
      displayName: "Gemini 3.1 Flash Image Preview",
      description: "Image generation model with improved visual quality.",
      contextLength: 1048576,
      maxCompletionTokens: 65536,
      mediaTypes: AllMediaTypes,
      regex: /gemini-3\.1-flash-image-preview/i,
      recommendedFor: ["chat"],
    },
    // Gemini 3 series
    {
      model: "gemini-3-flash-preview",
      displayName: "Gemini 3 Flash Preview",
      description:
        "High-speed thinking model for agentic workflows, multi-turn chat, and coding.",
      contextLength: 1048576,
      maxCompletionTokens: 65536,
      mediaTypes: AllMediaTypes,
      regex: /gemini-3-flash-preview/i,
      recommendedFor: ["chat"],
    },
    // Gemini 2.5 series (gemini-2.5-pro and gemini-2.5-flash are rerouted on 2026-12-01)
    {
      model: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      description:
        "Google's advanced model with strong reasoning, multimodal capabilities, and advanced coding skills",
      contextLength: 1048576,
      maxCompletionTokens: 65536,
      mediaTypes: AllMediaTypes,
      regex: /^gemini-2\.5-pro$/i,
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-12-01" },
    },
    {
      model: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      description:
        "Fast, token-efficient multimodal model for complex tasks with 1M context window",
      contextLength: 1048576,
      maxCompletionTokens: 65536,
      mediaTypes: AllMediaTypes,
      regex: /^gemini-2\.5-flash$/i,
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-12-01" },
    },
    {
      model: "gemini-2.5-flash-lite",
      displayName: "Gemini 2.5 Flash Lite",
      description:
        "Lightweight, fast model optimized for low-latency tasks with 1M context window",
      contextLength: 1048576,
      maxCompletionTokens: 65536,
      mediaTypes: AllMediaTypes,
      regex: /gemini-2\.5-flash-lite/i,
      recommendedFor: ["chat"],
    },
    // embed
    {
      model: "gemini-embedding-2",
      displayName: "Gemini Embedding 2",
      description: "Text embedding model for vectorizing content",
      regex: /^(?:models\/)?gemini-embedding-2/i,
      recommendedFor: ["embed"],
    },
  ],
  id: "gemini",
  displayName: "Gemini",
};
