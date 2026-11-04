import { ModelProvider } from "../types.js";

export const CometAPI: ModelProvider = {
  id: "cometapi",
  displayName: "CometAPI",
  models: [
    // GPT Series
    {
      model: "gpt-5-mini",
      displayName: "GPT-5 Mini",
      contextLength: 128000,
      maxCompletionTokens: 4096,
      description:
        "Efficient version of GPT-5 with faster response times while maintaining high quality.",
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-12-11" },
    },
    {
      model: "gpt-5-nano",
      displayName: "GPT-5 Nano",
      contextLength: 64000,
      maxCompletionTokens: 2048,
      description:
        "Ultra-fast GPT-5 variant optimized for quick responses and simple tasks.",
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-12-11" },
    },
    {
      model: "gpt-5",
      displayName: "GPT-5",
      contextLength: 200000,
      maxCompletionTokens: 8192,
      description:
        "Advanced GPT-5 model with state-of-the-art language understanding and generation.",
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-12-11" },
    },
    {
      model: "gpt-4o-mini",
      displayName: "GPT-4o Mini",
      contextLength: 128000,
      maxCompletionTokens: 4096,
      description:
        "Compact version of GPT-4o with excellent performance for most use cases.",
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "unscheduled" },
    },
    {
      model: "o3-pro-2025-06-10",
      displayName: "o3 Pro (2025-06-10)",
      contextLength: 200000,
      maxCompletionTokens: 8192,
      description:
        "Professional-grade o3 model with enhanced reasoning and problem-solving capabilities.",
      recommendedFor: ["chat"],
      // OpenAI retires o3 and o3-pro snapshots on this date
      deprecation: { shutdownDate: "2026-12-11" },
    },

    // Claude Series
    {
      model: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      contextLength: 200000,
      maxCompletionTokens: 64000,
      description:
        "Anthropic's latest and most capable Sonnet model with exceptional coding, reasoning, and multilingual performance.",
      recommendedFor: ["chat"],
    },
    {
      model: "claude-opus-4-6",
      displayName: "Claude Opus 4.6",
      contextLength: 200000,
      maxCompletionTokens: 64000,
      description:
        "Anthropic's most intelligent model with the highest level of capability for complex reasoning and agentic tasks.",
      recommendedFor: ["chat"],
    },
    {
      model: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      contextLength: 200000,
      maxCompletionTokens: 64000,
      description:
        "Previous generation Sonnet model with strong performance in reasoning and multilingual tasks.",
      recommendedFor: ["chat"],
      deprecation: {
        shutdownDate: "2026-11-30",
        replacement: "claude-sonnet-5-5",
      },
    },
    {
      model: "claude-haiku-4-5-20251001",
      displayName: "Claude 4.5 Haiku (2025-10-01)",
      contextLength: 200000,
      maxCompletionTokens: 64000,
      description:
        "Anthropic's fastest model with near-frontier intelligence, ideal for quick and accurate responses.",
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-10-15" },
    },

    // Gemini Series
    {
      model: "gemini-3.1-pro-preview",
      displayName: "Gemini 3.1 Pro Preview",
      contextLength: 2000000,
      maxCompletionTokens: 8192,
      description:
        "Gemini flagship model with high precision multimodal capabilities.",
      recommendedFor: ["chat"],
    },
    {
      model: "gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      contextLength: 2000000,
      maxCompletionTokens: 8192,
      description:
        "Advanced Gemini model with extensive context window and multimodal capabilities.",
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-12-01" },
    },
    {
      model: "gemini-2.5-flash",
      displayName: "Gemini 2.5 Flash",
      contextLength: 1000000,
      maxCompletionTokens: 8192,
      description:
        "Fast Gemini model with large context window optimized for speed.",
      recommendedFor: ["chat"],
      deprecation: { shutdownDate: "2026-12-01" },
    },
    {
      model: "gemini-2.5-flash-lite",
      displayName: "Gemini 2.5 Flash Lite",
      contextLength: 1000000,
      maxCompletionTokens: 4096,
      description:
        "Lightweight version of Gemini Flash for efficient processing.",
      recommendedFor: ["chat"],
    },

    // Grok Series

    // DeepSeek Series
    {
      model: "deepseek-v3.1",
      displayName: "DeepSeek V3.1",
      contextLength: 128000,
      maxCompletionTokens: 4096,
      description:
        "Latest DeepSeek model with improved reasoning and coding capabilities.",
      recommendedFor: ["chat"],
    },
    {
      model: "deepseek-v3",
      displayName: "DeepSeek V3",
      contextLength: 128000,
      maxCompletionTokens: 4096,
      description:
        "Advanced DeepSeek model with strong performance in technical domains.",
      recommendedFor: ["chat"],
    },
    {
      model: "deepseek-r1-0528",
      displayName: "DeepSeek R1 (05-28)",
      contextLength: 128000,
      maxCompletionTokens: 4096,
      description:
        "DeepSeek reasoning model optimized for complex problem-solving tasks.",
      recommendedFor: ["chat"],
    },

    // Qwen Series
    {
      model: "qwen3-30b-a3b",
      displayName: "Qwen3 30B A3B",
      contextLength: 128000,
      maxCompletionTokens: 4096,
      description:
        "Large Qwen model with 30B parameters for high-quality text generation.",
      recommendedFor: ["chat"],
    },
    {
      model: "qwen3-coder-plus-2025-07-22",
      displayName: "Qwen3 Coder Plus (2025-07-22)",
      contextLength: 128000,
      maxCompletionTokens: 4096,
      description:
        "Qwen model specialized for coding tasks with enhanced programming capabilities.",
      recommendedFor: ["chat"],
    },
  ],
};
