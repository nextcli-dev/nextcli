import { createOpenAISubclassTests } from "./test-utils/openai-test-utils.js";
import Groq from "./Groq.js";

createOpenAISubclassTests(Groq, {
  providerName: "groq",
  defaultApiBase: "https://api.groq.com/openai/v1/",
});
