import { ModelProvider } from "../types.js";

// Ids from docs.x.ai/docs/models (2026-11-04). Every earlier model (grok-beta,
// grok-2, grok-3*, grok-4, grok-4-fast*, grok-4-1-fast*, grok-code-fast-1) was
// retired on 2026-05-15. Context limits are left unset until confirmed per model.
export const xAI: ModelProvider = {
  models: [
    {
      model: "grok-4.7",
      displayName: "Grok 4.7",
      recommendedFor: ["chat"],
      regex: /^grok-4\.7/,
    },
    {
      model: "grok-4.6",
      displayName: "Grok 4.6",
      recommendedFor: ["chat"],
      regex: /^grok-4\.6/,
    },
    {
      model: "grok-4.3",
      displayName: "Grok 4.3",
      recommendedFor: ["chat"],
      regex: /^grok-4\.3/,
    },
    {
      model: "grok-4.20-0309-reasoning",
      displayName: "Grok 4.20 Reasoning",
      recommendedFor: ["chat"],
      regex: /^grok-4\.20/,
    },
    {
      model: "grok-build-0.1",
      displayName: "Grok Build 0.1",
      recommendedFor: ["chat"],
      regex: /^grok-build/,
    },
  ],
  id: "xAI",
  displayName: "xAI",
};
