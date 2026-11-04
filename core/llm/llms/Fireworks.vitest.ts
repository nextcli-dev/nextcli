import Fireworks from "./Fireworks.js";
import { createOpenAISubclassTests } from "./test-utils/openai-test-utils.js";

createOpenAISubclassTests(Fireworks, {
  providerName: "fireworks",
  defaultApiBase: "https://api.fireworks.ai/inference/v1/",
});
