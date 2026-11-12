import { ModelProvider } from "../types.js";

// From https://api-docs.deepseek.com/quick_start/pricing (checked 2026-11-10):
// 1M context, up to 384K output. Thinking is on by default and its tokens
// share the output cap, so the 4096 fallback can end a turn mid-thought.
const V4_LIMITS = {
  contextLength: 1_000_000,
  maxCompletionTokens: 384_000,
};

export const DeepSeek: ModelProvider = {
  id: "deepseek",
  displayName: "DeepSeek",
  models: [
    {
      model: "deepseek-v4-pro",
      displayName: "DeepSeek V4 Pro",
      ...V4_LIMITS,
    },
    {
      model: "deepseek-flash",
      displayName: "DeepSeek Flash",
      ...V4_LIMITS,
    },
    // Legacy names, served by deepseek-flash
    {
      model: "deepseek-v4-flash",
      displayName: "DeepSeek V4 Flash",
      ...V4_LIMITS,
    },
    {
      model: "deepseek-v4-flash-vision-exp",
      displayName: "DeepSeek V4 Flash Vision (experimental)",
      ...V4_LIMITS,
    },
    // Any other V4 id, such as deepseek-v4.1-flash or a provider-prefixed
    // deepseek/deepseek-v4-pro. Last, so the exact names above win.
    {
      model: "deepseek-v4",
      displayName: "DeepSeek V4",
      regex: /deepseek-v4/i,
      ...V4_LIMITS,
    },
  ],
};
