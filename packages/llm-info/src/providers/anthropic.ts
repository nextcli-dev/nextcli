import { ModelProvider } from "../types.js";

export const Anthropic: ModelProvider = {
  id: "anthropic",
  displayName: "Anthropic",
  models: [
    {
      model: "claude-fable-5-1",
      displayName: "Claude Fable 5.1",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description:
        "Anthropic's most capable model for the hardest reasoning and agentic tasks.",
      regex: /claude-fable-5[.-]1.*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-opus-5-5",
      displayName: "Claude Opus 5.5",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description:
        "Anthropic's most intelligent Opus model for complex reasoning, coding and agentic tasks.",
      regex: /claude-opus-5[.-]5.*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description:
        "Anthropic's latest Sonnet model, balancing coding and reasoning performance with speed and cost.",
      regex: /claude-sonnet-5[.-]5.*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-haiku-5-5",
      displayName: "Claude Haiku 5.5",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description:
        "Anthropic's fastest and most cost-effective model, priced higher for prompts over 100K tokens.",
      regex: /claude-haiku-5[.-]5.*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-fable-5",
      displayName: "Claude Fable 5",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description: "Previous generation Fable model.",
      regex: /claude-fable-5(?![.-]\d).*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-opus-5",
      displayName: "Claude Opus 5",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description: "Previous generation Opus model.",
      regex: /claude-opus-5(?![.-]\d).*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description: "Previous generation Sonnet model.",
      regex: /claude-sonnet-5(?![.-]\d).*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-opus-4-8",
      displayName: "Claude Opus 4.8",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description: "Previous generation Opus model.",
      regex: /claude-opus-4[.-]8.*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-opus-4-7",
      displayName: "Claude Opus 4.7",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description: "Previous generation Opus model.",
      regex: /claude-opus-4[.-]7.*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description:
        "Previous generation Sonnet model with exceptional coding, reasoning, and multilingual performance.",
      regex: /claude-(?:4[.-]6-sonnet|sonnet-4[.-]6).*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      contextLength: 1000000,
      maxCompletionTokens: 128000,
      description:
        "Previous generation Opus model with the highest level of capability for complex reasoning and agentic tasks.",
      regex: /claude-(?:4[.-]6-opus|opus-4[.-]6).*/i,
      recommendedFor: ["chat"],
    },
    {
      model: "claude-sonnet-4-5-20250929",
      displayName: "Claude Sonnet 4.5",
      contextLength: 200000,
      maxCompletionTokens: 64000,
      description:
        "Previous generation Sonnet model with strong performance in reasoning and multilingual tasks.",
      regex: /claude-(?:4[.-]5-sonnet|sonnet-4[.-]5).*/i,
      recommendedFor: ["chat"],
      deprecation: {
        shutdownDate: "2026-11-30",
        replacement: "claude-sonnet-5-5",
      },
    },
    {
      model: "claude-haiku-4-5-20251001",
      displayName: "Claude Haiku 4.5",
      contextLength: 200000,
      maxCompletionTokens: 64000,
      description:
        "Anthropic's fastest model with near-frontier intelligence, ideal for quick and accurate responses.",
      regex: /claude-(?:4[.-]5-haiku|haiku-4[.-]5).*/i,
      recommendedFor: ["chat"],
      // Anthropic: shut down on or after 2026-10-15
      deprecation: { shutdownDate: "2026-10-15" },
    },
    {
      model: "claude-opus-4-5",
      displayName: "Claude Opus 4.5",
      contextLength: 200000,
      maxCompletionTokens: 64000,
      description:
        "Previous generation Opus with high intelligence and capability.",
      regex: /claude-(?:4-5-opus|opus-4-5).*/i,
      recommendedFor: ["chat"],
      // Anthropic: shut down on or after 2026-11-24
      deprecation: { shutdownDate: "2026-11-24" },
    },
  ],
};
