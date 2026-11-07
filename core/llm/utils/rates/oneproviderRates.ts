import type { HostRates } from "./hostRates";

// Text models from https://oneprovider.dev/pricing (checked 2026-11-07), in US
// dollars per million tokens. The page lists no cache prices, so cached tokens
// cost the input price. Image, audio and video models are left out.
// Matched by prefix, longest first, so dated and -thinking variants share a row.
export const ONEPROVIDER_RATES: Record<string, HostRates> = {
  // Anthropic
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },

  // DeepSeek
  "deepseek-v4.1-flash": { input: 0.3, output: 1.2 },
  "deepseek-v4-flash": { input: 0.3, output: 1.2 },
  "deepseek-v4-flash-vision-exp": { input: 0.3, output: 1.2 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96 },

  // Google
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5 },
  "gemini-3.1-pro": { input: 2, output: 12 },
  "gemini-3.5-flash": { input: 1.5, output: 9 },
  "gemini-3.6-flash": { input: 0.75, output: 3.75 },
  "gemini-3.7-flash": { input: 0.75, output: 3.75 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-4-argon": { input: 2, output: 10 },

  // Zhipu
  "glm-5.3-flash": { input: 0.15, output: 0.5 },
  "glm-5.3": { input: 1.4, output: 4.4 },
  "glm-5.2": { input: 1.4, output: 4.4 },
  "glm-5.1": { input: 1.4, output: 4.4 },

  // OpenAI
  "gpt-6.1-sol": { input: 2, output: 10 },
  "gpt-6.1-terra": { input: 1, output: 5 },
  "gpt-6-astra": { input: 10, output: 50 },
  "gpt-6-sol": { input: 2, output: 10 },
  "gpt-6-luna": { input: 0.1, output: 0.5 },
  "gpt-5.6-sol": { input: 5, output: 30 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-luna": { input: 1, output: 6 },
  "gpt-5.5": { input: 5, output: 30 },

  // xAI
  "grok-4.7": { input: 2, output: 6 },
  "grok-4.6": { input: 2, output: 6 },
  "grok-4.5": { input: 2, output: 6 },

  // Moonshot
  "kimi-k3.1-pro": { input: 2, output: 10 },
  "kimi-k3": { input: 3, output: 15 },
  "kimi-k2.7-code": { input: 0.95, output: 4 },

  // Qwen
  "qwen3.8-max": { input: 1.65, output: 4.951 },
  "qwen3.8-flash": { input: 0.15, output: 0.47 },
  "qwen3.7-max": { input: 1.65, output: 4.951 },
  "qwen3.7-plus": { input: 0.4, output: 1.6 },

  // MiniMax
  "minimax-m3.1-flash": { input: 0.15, output: 0.6 },
  "minimax-m3": { input: 0.3, output: 1.2 },
  "minimax-m2.7": { input: 0.3, output: 1.2 },
};
