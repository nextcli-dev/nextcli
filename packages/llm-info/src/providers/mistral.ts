import { ModelProvider } from "../types.js";

export const Mistral: ModelProvider = {
  models: [
    // Context limits for these are left unset until confirmed from docs.mistral.ai
    {
      model: "mistral-large-4",
      displayName: "Mistral Large 4",
      description:
        "Mistral's flagship model for complex reasoning, coding and agents.",
      regex: /^mistral-large-4/i,
      recommendedFor: ["chat"],
    },
    {
      model: "mistral-large-2512",
      displayName: "Mistral Large (2512)",
      regex: /^mistral-large-2512/i,
      deprecation: { shutdownDate: "2027-04-30" },
    },
    {
      model: "mistral-medium-3-5",
      displayName: "Mistral Medium 3.5",
      regex: /^mistral-medium-3[.-]5/i,
      deprecation: { shutdownDate: "2027-04-30" },
    },
    {
      model: "mistral-large-latest",
      displayName: "Mistral Large",
      contextLength: 32768,
      description:
        "Flagship model ideal for complex tasks requiring large reasoning capabilities or highly specialized tasks like synthetic text generation, code generation, RAG, or agents.",
      regex: /mistral-large/i,
      recommendedFor: ["chat"],
    },
    {
      model: "mistral-medium-latest",
      displayName: "Mistral Medium",
      contextLength: 32768,
      description:
        "Ideal for intermediate tasks requiring moderate reasoning such as data extraction, document summarization, email writing, job descriptions, or product descriptions. (Note: Will be deprecated in the coming months)",
      regex: /mistral-medium/i,
    },
    {
      model: "mistral-small-latest",
      displayName: "Mistral Small",
      contextLength: 32768,
      description:
        "Suitable for simple tasks that can be done in bulk like classification, customer support, or text generation.",
      regex: /mistral-small/i,
    },
    {
      model: "mistral-embed",
      displayName: "Mistral Embeddings",
      contextLength: 8192,
      description:
        "Model that converts text into numerical vectors of embeddings in 1024 dimensions. Enables retrieval and retrieval-augmented generation applications with a retrieval score of 55.26 on MTEB.",
      regex: /mistral-embed/i,
      recommendedFor: ["embed"],
    },
    // devstral family
    {
      model: "devstral-medium-latest",
      displayName: "Devstral Medium",
      contextLength: 262144,
      maxCompletionTokens: 262144,
      description:
        "A medium-sized code-focused model from Mistral AI with extended context.",
      regex: /devstral-medium/i,
      recommendedFor: ["chat"],
    },
    // magistral family
    // ministral family
    {
      model: "ministral-3b-latest",
      displayName: "Ministral 3B",
      contextLength: 128000,
      maxCompletionTokens: 128000,
      description:
        "Mistral's tiny model for lightweight tasks and edge deployments.",
      regex: /ministral-3b/i,
      recommendedFor: ["chat"],
    },
    {
      model: "ministral-8b-latest",
      displayName: "Ministral 8B",
      contextLength: 128000,
      maxCompletionTokens: 128000,
      description: "Mistral's small model balancing capability and efficiency.",
      regex: /ministral-8b/i,
      recommendedFor: ["chat"],
    },
    // mistral-nemo
    {
      model: "mistral-nemo",
      displayName: "Mistral Nemo",
      contextLength: 128000,
      maxCompletionTokens: 128000,
      description:
        "An open-weight model from Mistral AI and NVIDIA with strong performance.",
      regex: /mistral-nemo/i,
      recommendedFor: ["chat"],
    },
    {
      model: "codestral-latest",
      displayName: "Codestral",
      contextLength: 32768,
      description:
        "Cutting-edge generative model specifically designed and optimized for code generation tasks, including fill-in-the-middle and code completion.",
      regex: /codestral/i,
      recommendedFor: ["autocomplete"],
    },
  ],
  id: "mistral",
  displayName: "Mistral",
};
