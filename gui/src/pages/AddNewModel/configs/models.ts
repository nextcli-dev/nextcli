import { ILLM } from "core";
import { ModelProviderTags } from "../../../components/modelSelection/utils";
import { InputDescriptor } from "./providers";

// A dimension is like parameter count - 7b, 13b, 34b, etc.
// You would set options to the field that should be changed for that option in the params field of ModelPackage
export interface PackageDimension {
  name: string;
  description: string;
  options: { [key: string]: { [key: string]: any } };
}

export interface DisplayInfo {
  title: string;
  icon?: string;
}

export interface ModelPackage {
  title: string;
  icon?: string;
  collectInputFor?: InputDescriptor[];
  description: string;
  refUrl?: string;
  tags?: ModelProviderTags[];
  params: {
    model: ILLM["model"];
    templateMessages?: ILLM["templateMessages"];
    contextLength?: ILLM["contextLength"];
    stopTokens?: string[];
    promptTemplates?: ILLM["promptTemplates"];
    replace?: [string, string][];
    [key: string]: any;
  };
  dimensions?: PackageDimension[];
  providerOptions?: string[];
  isOpenSource: boolean;
}

export const models: { [key: string]: ModelPackage } = {
  hermes3Llama31_405b: {
    title: "Hermes 3 Llama 3.1 405B",
    description:
      "Nous Research's Hermes 3, a powerful instruction-tuned model built on Llama 3.1 405B with strong reasoning and tool use capabilities.",
    refUrl: "https://nousresearch.com/hermes3",
    params: {
      title: "Hermes 3 Llama 3.1 405B",
      model: "Hermes-3-Llama-3.1-405B",
      contextLength: 32_000,
    },
    icon: "nous.png",
    providerOptions: ["nous"],
    isOpenSource: true,
  },
  hermes3Llama31_70b: {
    title: "Hermes 3 Llama 3.1 70B",
    description:
      "Nous Research's Hermes 3, built on Llama 3.1 70B with strong instruction following and reasoning.",
    refUrl: "https://nousresearch.com/hermes3",
    params: {
      title: "Hermes 3 Llama 3.1 70B",
      model: "Hermes-3-Llama-3.1-70B",
      contextLength: 32_000,
    },
    icon: "nous.png",
    providerOptions: ["nous"],
    isOpenSource: true,
  },
  hermes4_405b: {
    title: "Hermes 4 405B",
    description:
      "Nous Research's Hermes 4, featuring enhanced reasoning with thinking tags for chain-of-thought.",
    refUrl: "https://nousresearch.com",
    params: {
      title: "Hermes 4 405B",
      model: "Hermes-4-405B",
      contextLength: 128_000,
    },
    icon: "nous.png",
    providerOptions: ["nous"],
    isOpenSource: true,
  },
  hermes4_70b: {
    title: "Hermes 4 70B",
    description:
      "Nous Research's Hermes 4 70B with reasoning capabilities and 128k context.",
    refUrl: "https://nousresearch.com",
    params: {
      title: "Hermes 4 70B",
      model: "Hermes-4-70B",
      contextLength: 128_000,
    },
    icon: "nous.png",
    providerOptions: ["nous"],
    isOpenSource: true,
  },
  hermes43_36b: {
    title: "Hermes 4.3 36B",
    description:
      "Nous Research's Hermes 4.3 36B, a compact reasoning model with 128k context.",
    refUrl: "https://nousresearch.com",
    params: {
      title: "Hermes 4.3 36B",
      model: "Hermes-4.3-36B",
      contextLength: 128_000,
    },
    icon: "nous.png",
    providerOptions: ["nous"],
    isOpenSource: true,
  },
  gptOss20B: {
    title: "gpt-oss-20b",
    description:
      "OpenAI's 20B open-weight model with native tool use and reasoning for agentic tasks.",
    refUrl: "https://huggingface.co/openai/gpt-oss-20b",
    params: {
      title: "gpt-oss-20b",
      model: "openai/gpt-oss-20b",
      contextLength: 128_000,
    },
    icon: "openai.png",
    dimensions: [
      {
        name: "Provider",
        description: "The provider to use for this model",
        options: {
          vllm: {
            model: "openai/gpt-oss-20b",
            title: "gpt-oss-20b (vLLM)",
          },
        },
      },
    ],
    providerOptions: ["vllm"],
    isOpenSource: true,
  },
  gptOss120B: {
    title: "gpt-oss-120b",
    description:
      "OpenAI's 120B flagship open-weight model built for complex, high‑reasoning agentic workflows.",
    refUrl: "https://huggingface.co/openai/gpt-oss-120b",
    params: {
      title: "gpt-oss-120b",
      model: "openai/gpt-oss-120b",
      contextLength: 128_000,
    },
    icon: "openai.png",
    dimensions: [
      {
        name: "Provider",
        description: "The provider to use for this model",
        options: {
          vllm: {
            model: "openai/gpt-oss-120b",
            title: "gpt-oss-120b (vLLM)",
          },
        },
      },
    ],
    providerOptions: ["vllm"],
    isOpenSource: true,
  },
  llama31Chat: {
    title: "Llama3.1 Chat",
    description: "A model from Meta, fine-tuned for chat",
    refUrl: "",
    params: {
      title: "Llama3.1-8b",
      model: "llama3.1-8b",
      contextLength: 8192,
    },
    icon: "meta.png",
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "8b": {
            model: "llama3.1-8b",
            title: "Llama3.1-8b",
          },
          "70b": {
            model: "llama3.1-70b",
            title: "Llama3.1-70b",
          },
          "405b": {
            model: "llama3.1-405b",
            title: "Llama3.1-405b",
          },
        },
      },
    ],
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    isOpenSource: true,
  },
  llama32Chat: {
    title: "Llama3.2 Chat",
    description:
      "The latest model from Meta, fine-tuned for chat. Llama3.1 recommended - chat stayed the same",
    refUrl: "",
    params: {
      title: "Llama3.2-11b",
      model: "llama3.2-11b",
      contextLength: 8192,
    },
    icon: "meta.png",
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "1b": {
            model: "llama3.2-1b",
            title: "Llama3.2-1b",
          },
          "3b": {
            model: "llama3.2-3b",
            title: "Llama3.2-3b",
          },
          "11b": {
            model: "llama3.2-11b",
            title: "Llama3.2-11b",
          },
          "90b": {
            model: "llama3.2-90b",
            title: "Llama3.2-90b",
          },
        },
      },
    ],
    providerOptions: ["ollama", "llama.cpp"],
    isOpenSource: true,
  },
  deepseek: {
    title: "DeepSeek Coder",
    description:
      "A model pre-trained on 2 trillion tokens including 80+ programming languages and a repo-level corpus.",
    params: {
      title: "DeepSeek-7b",
      model: "deepseek-7b",
      contextLength: 4096,
    },
    icon: "deepseek.png",
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "1b": {
            model: "deepseek-1b",
            title: "DeepSeek-1b",
          },
          "7b": {
            model: "deepseek-7b",
            title: "DeepSeek-7b",
          },
          "33b": {
            model: "deepseek-33b",
            title: "DeepSeek-33b",
          },
        },
      },
    ],
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    isOpenSource: true,
  },
  exaone32B: {
    title: "EXAONE 4.0.1-32B",
    description:
      "LG AI Research's 32B model with integrated reasoning and agentic tool use capabilities.",
    refUrl: "https://huggingface.co/LGAI-EXAONE/EXAONE-4.0.1-32B",
    params: {
      title: "EXAONE-4.0.1-32B",
      model: "LGAI-EXAONE/EXAONE-4.0.1-32B",
      contextLength: 131072,
    },
    providerOptions: ["openai"],
    isOpenSource: true,
  },
  exaone12B: {
    title: "EXAONE 4.0-1.2B",
    description:
      "Compact EXAONE 4.0 model suitable for on-device use while retaining tool calling support.",
    refUrl: "https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-1.2B",
    params: {
      title: "EXAONE-4.0-1.2B",
      model: "LGAI-EXAONE/EXAONE-4.0-1.2B",
      contextLength: 65536,
    },
    providerOptions: ["openai"],
    isOpenSource: true,
  },
  glm5: {
    title: "GLM-5",
    description: "Z.ai's flagship GLM-5 model with 128k context",
    refUrl: "https://z.ai/model-api",
    params: {
      title: "GLM-5",
      model: "glm-5",
      contextLength: 128000,
    },
    icon: "zai.svg",
    providerOptions: ["zAI"],
    isOpenSource: false,
  },
  glm47: {
    title: "GLM-4.7",
    description: "Z.ai's latest GLM-4.7 model with 128k context",
    refUrl: "https://z.ai/model-api",
    params: {
      title: "GLM-4.7",
      model: "glm-4.7",
      contextLength: 128000,
    },
    icon: "zai.svg",
    providerOptions: ["zAI"],
    isOpenSource: false,
  },
  mistralOs: {
    title: "Mistral",
    description:
      "A series of open-weight models created by Mistral AI, highly competent for code generation and other tasks",
    params: {
      title: "Mistral",
      model: "mistral-7b",
      contextLength: 4096,
    },
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "7b": {
            model: "mistral-7b",
            title: "Mistral-7b",
          },
          "8x7b (MoE)": {
            model: "mistral-8x7b",
            title: "Mixtral",
          },
          "8x22b (MoE)": {
            model: "mistral-8x22b",
            title: "Mixtral",
          },
        },
      },
    ],
    icon: "mistral.png",
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    isOpenSource: true,
  },
  codeLlamaInstruct: {
    title: "CodeLlama Instruct",
    description:
      "A model from Meta, fine-tuned for code generation and conversation",
    refUrl: "",
    params: {
      title: "CodeLlama-7b",
      model: "codellama-7b",
      contextLength: 4096,
    },
    icon: "meta.png",
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "7b": {
            model: "codellama-7b",
            title: "CodeLlama-7b",
          },
          "13b": {
            model: "codellama-13b",
            title: "CodeLlama-13b",
          },
          "34b": {
            model: "codellama-34b",
            title: "CodeLlama-34b",
          },
          "70b": {
            model: "codellama-70b",
            title: "Codellama-70b",
          },
        },
      },
    ],
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    isOpenSource: true,
  },
  llama3170bNemotron: {
    title: "Llama 3.1 Nemotron 70B",
    description:
      "Llama-3.1-Nemotron-70B-Instruct is a large language model customized by NVIDIA to improve the helpfulness of LLM generated responses to user queries.",
    params: {
      title: "Llama 3.1 Nemotron 70B",
      model: "llama3.1-70b-nemotron",
      contextLength: 128_000,
    },
    icon: "meta.png",
    isOpenSource: true,
  },
  llama321bChat: {
    title: "Llama3.2 1b Chat",
    description:
      "The latest super-lightweight model from Meta, fine-tuned for chat",
    refUrl: "",
    params: {
      title: "Llama3.2-1b",
      model: "llama3.2-1b",
      contextLength: 8192,
    },
    icon: "meta.png",
    providerOptions: ["ollama", "llama.cpp"],
    isOpenSource: false,
  },
  llama323bChat: {
    title: "Llama3.2 3b Chat",
    description: "The latest lightweight model from Meta, fine-tuned for chat",
    refUrl: "",
    params: {
      title: "Llama3.2-3b",
      model: "llama3.2-3b",
      contextLength: 8192,
    },
    icon: "meta.png",
    providerOptions: ["ollama", "llama.cpp"],
    isOpenSource: false,
  },
  llama3211bChat: {
    title: "Llama3.2 11b Chat",
    description: "The latest lightweight multi-modal model from Meta",
    refUrl: "",
    params: {
      title: "Llama3.2-11b",
      model: "llama3.2-11b",
      contextLength: 8192,
    },
    icon: "meta.png",
    providerOptions: ["ollama", "llama.cpp"],
    isOpenSource: false,
  },
  llama3290bChat: {
    title: "Llama3.2 90b Chat",
    description: "The latest lightweight multi-modal model from Meta",
    refUrl: "",
    params: {
      title: "Llama3.2-90b",
      model: "llama3.2-90b",
      contextLength: 8192,
    },
    icon: "meta.png",
    providerOptions: ["ollama", "llama.cpp"],
    isOpenSource: false,
  },
  llama3Chat: {
    title: "Llama3 Chat",
    description: "A model from Meta, fine-tuned for chat",
    refUrl: "",
    params: {
      title: "Llama3-8b",
      model: "llama3-8b",
      contextLength: 8192,
    },
    icon: "meta.png",
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "8b": {
            model: "llama3-8b",
            title: "Llama3-8b",
          },
          "70b": {
            model: "llama3-70b",
            title: "Llama3-70b",
          },
        },
      },
    ],
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    isOpenSource: true,
  },
  graniteCodeOpenSource: {
    title: "Granite Code",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "granite-code",
      contextLength: 20_000,
      title: "Granite Code",
    },
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    icon: "ibm.png",
    isOpenSource: true,
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "3b": {
            model: "granite-code-3b",
            title: "Granite Code 3B",
          },
          "8b": {
            model: "granite-code-8b",
            title: "Granite Code 8B",
          },
          "20b": {
            model: "granite-code-20b",
            title: "Granite Code 20B",
          },
          "34b": {
            model: "granite-code-34b",
            title: "Granite Code 34B",
          },
        },
      },
    ],
  },
  wizardCoder: {
    title: "WizardCoder",
    description:
      "A CodeLlama-based code generation model from WizardLM, focused on Python",
    refUrl: "",
    params: {
      title: "WizardCoder-7b",
      model: "wizardcoder-7b",
      contextLength: 4096,
    },
    icon: "wizardlm.png",
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "7b": {
            model: "wizardcoder-7b",
            title: "WizardCoder-7b",
          },
          "13b": {
            model: "wizardcoder-13b",
            title: "WizardCoder-13b",
          },
          "34b": {
            model: "wizardcoder-34b",
            title: "WizardCoder-34b",
          },
        },
      },
    ],
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    isOpenSource: true,
  },
  phindCodeLlama: {
    title: "Phind CodeLlama (34b)",
    description: "A finetune of CodeLlama by Phind",
    icon: "meta.png",
    params: {
      title: "Phind CodeLlama",
      model: "phind-codellama-34b",
      contextLength: 4096,
    },
    providerOptions: ["ollama", "lmstudio", "llama.cpp"],
    isOpenSource: true,
  },
  codestral: {
    title: "Codestral",
    description:
      "Codestral is an advanced generative model created by Mistral AI, tailored for coding tasks like fill-in-the-middle and code completion.",
    params: {
      title: "Codestral",
      model: "codestral-latest",
      contextLength: 32000,
    },
    icon: "mistral.png",
    providerOptions: ["mistral"],
    isOpenSource: true,
  },
  mistralSmall: {
    title: "Mistral Small",
    description:
      "Suitable for simple tasks that one can do in bulk (Classification, Customer Support, or Text Generation)",
    params: {
      title: "Mistral Small",
      model: "mistral-small-latest",
      contextLength: 32000,
    },
    icon: "mistral.png",
    providerOptions: ["mistral"],
    isOpenSource: false,
  },
  mistralLarge: {
    title: "Mistral Large",
    description:
      "Mistral's flagship model that's ideal for complex tasks that require large reasoning capabilities or are highly specialized (Synthetic Text Generation, Code Generation, RAG, or Agents).",
    params: {
      title: "Mistral Large",
      model: "mistral-large-latest",
      contextLength: 32000,
    },
    icon: "mistral.png",
    providerOptions: ["mistral"],
    isOpenSource: false,
  },
  mistralNemo: {
    title: "Mistral Nemo",
    description:
      "Mistral Nemo Instruct is a large language model developed by Mistral AI and NVIDIA.",
    params: {
      title: "Mistral Nemo",
      model: "mistral-nemo",
      contextLength: 128_000,
    },
    icon: "mistral.png",
    isOpenSource: true,
  },
  gemini31ProPreview: {
    title: "Gemini 3.1 Pro",
    description:
      "Google's most capable model with 2M context window. Best for complex tasks involving reasoning.",
    params: {
      title: "Gemini 3.1 Pro",
      model: "gemini-3.1-pro-preview",
      contextLength: 2_097_152,
      apiKey: "<API_KEY>",
    },
    icon: "gemini.png",
    providerOptions: ["gemini"],
    isOpenSource: false,
  },
  commandR082024: {
    title: "Command R 08-2024",
    description:
      "Command R is a scalable generative model targeting RAG and Tool Use to enable production-scale AI for enterprise.",
    params: {
      model: "command-r-08-2024",
      contextLength: 128_000,
      title: "Command R 08-2024",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  commandRPlus082024: {
    title: "Command R+ 08-2024",
    description:
      "Command R+ is a state-of-the-art RAG-optimized model designed to tackle enterprise-grade workloads.",
    params: {
      model: "command-r-plus-08-2024",
      contextLength: 128_000,
      title: "Command R+ 08-2024",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  commandR7B122024: {
    title: "Command R7B 12-2024",
    description:
      "The smallest model in our R series delivers top-tier speed, efficiency, and quality to build powerful AI applications on commodity GPUs and edge devices.",
    params: {
      model: "command-r7b-12-2024",
      contextLength: 128_000,
      title: "Command R7B 12-2024",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  commandR7BArabic022025: {
    title: "Command R7B Arabic 02-2025",
    description:
      "Our state-of-the-art lightweight multilingual AI model has been optimized for advanced Arabic language capabilities to support enterprises in the MENA region.",
    params: {
      model: "command-r7b-arabic-02-2025",
      contextLength: 128_000,
      title: "Command R7B Arabic 02-2025",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  commandA032025: {
    title: "Command A 03-2025",
    description:
      "Command A is Cohere’s most performant model to date, excelling at real world enterprise tasks including tool use, retrieval augmented generation (RAG), agents, and multilingual use cases.",
    params: {
      model: "command-a-03-2025",
      contextLength: 256_000,
      title: "Command A 03-2025",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  commandAVision072025: {
    title: "Command A Vision 07-2025",
    description:
      "Command A Vision is Cohere's first model capable of processing images, excelling in enterprise use cases such as analyzing charts, graphs, and diagrams, table understanding, OCR, document Q&A, and object detection.",
    params: {
      model: "command-a-vision-07-2025",
      contextLength: 128_000,
      title: "Command A Vision 07-2025",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  commandAReasoning082025: {
    title: "Command A Reasoning 08-2025",
    description:
      "Command A Reasoning is Cohere’s first reasoning model, able to ‘think’ before generating an output in a way that allows it to perform well in certain kinds of nuanced problem-solving and agent-based tasks in 23 languages.",
    params: {
      model: "command-a-reasoning-08-2025",
      contextLength: 256_000,
      title: "Command A Reasoning 08-2025",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  commandATranslate082025: {
    title: "Command A Translate 08-2025",
    description:
      "Command A Translate is Cohere’s state of the art machine translation model, excelling at a variety of translation tasks on 23 languages",
    params: {
      model: "command-a-translate-08-2025",
      contextLength: 8_000,
      title: "Command A Translate 08-2025",
      apiKey: "",
    },
    providerOptions: ["cohere"],
    icon: "cohere.png",
    isOpenSource: false,
  },
  claude55Opus: {
    title: "Claude Opus 5.5",
    description:
      "Anthropic's current Opus model for complex reasoning, coding and agentic tasks.",
    params: {
      model: "claude-opus-5-5",
      contextLength: 1_000_000,
      title: "Claude Opus 5.5",
      apiKey: "",
    },
    providerOptions: ["anthropic"],
    icon: "anthropic.png",
    isOpenSource: false,
  },
  claude55Sonnet: {
    title: "Claude Sonnet 5.5",
    description:
      "Anthropic's current Sonnet model, balancing speed and capability for everyday coding and agent work.",
    params: {
      model: "claude-sonnet-5-5",
      contextLength: 1_000_000,
      title: "Claude Sonnet 5.5",
      apiKey: "",
    },
    providerOptions: ["anthropic"],
    icon: "anthropic.png",
    isOpenSource: false,
  },
  claude55Haiku: {
    title: "Claude Haiku 5.5",
    description:
      "Anthropic's fastest and lowest-cost current model, for quick responses and autocomplete-style tasks.",
    params: {
      model: "claude-haiku-5-5",
      contextLength: 1_000_000,
      title: "Claude Haiku 5.5",
      apiKey: "",
    },
    providerOptions: ["anthropic"],
    icon: "anthropic.png",
    isOpenSource: false,
  },
  claude46Sonnet: {
    title: "Claude Sonnet 4.6",
    description:
      "Previous generation Sonnet model with strong coding, reasoning, and multilingual performance.",
    params: {
      model: "claude-sonnet-4-6",
      contextLength: 200_000,
      title: "Claude Sonnet 4.6",
      apiKey: "",
    },
    providerOptions: ["anthropic"],
    icon: "anthropic.png",
    isOpenSource: false,
  },
  claude46Opus: {
    title: "Claude Opus 4.6",
    description:
      "Previous generation Opus model for complex reasoning and agentic tasks.",
    params: {
      model: "claude-opus-4-6",
      contextLength: 200_000,
      title: "Claude Opus 4.6",
      apiKey: "",
    },
    providerOptions: ["anthropic"],
    icon: "anthropic.png",
    isOpenSource: false,
  },
  graniteChat: {
    title: "Granite Chat 13b",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "ibm/granite-13b-chat-v2",
      contextLength: 8_000,
      title: "Granite Chat 13b",
    },
    providerOptions: ["watsonx"],
    icon: "WatsonX.png",
    isOpenSource: false,
  },
  graniteCode3b: {
    title: "Granite Code 3b",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "ibm/granite-3b-code-instruct",
      contextLength: 2_000,
      title: "Granite Code 3b",
    },
    providerOptions: ["watsonx"],
    icon: "WatsonX.png",
    isOpenSource: false,
  },
  graniteCode8b: {
    title: "Granite Code 8b",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "ibm/granite-8b-code-instruct",
      contextLength: 4_000,
      title: "Granite Code 8b",
    },
    providerOptions: ["watsonx"],
    icon: "WatsonX.png",
    isOpenSource: false,
  },
  graniteCode20b: {
    title: "Granite Code 20b",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "ibm/granite-20b-code-instruct",
      contextLength: 8_000,
      title: "Granite Code 20b",
    },
    providerOptions: ["watsonx"],
    icon: "WatsonX.png",
    isOpenSource: false,
  },
  graniteCode34b: {
    title: "Granite Code 34b",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "ibm/granite-34b-code-instruct",
      contextLength: 8_000,
      title: "Granite Code 34b",
    },
    providerOptions: ["watsonx"],
    icon: "WatsonX.png",
    isOpenSource: false,
  },
  granite3Instruct8b: {
    title: "Granite 3.0 8b Instruct",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "ibm/granite-3-8b-instruct",
      contextLength: 8_000,
      title: "Granite 3.0 8b Instruct",
    },
    providerOptions: ["watsonx"],
    icon: "WatsonX.png",
    isOpenSource: false,
  },
  granite3Instruct2b: {
    title: "Granite 3.0 2b Instruct",
    description:
      "The Granite model series is a family of IBM-trained, dense decoder-only models, which are particularly well-suited for generative tasks.",
    params: {
      model: "ibm/granite-3-2b-instruct",
      contextLength: 2_000,
      title: "Granite 3.0 2b Instruct",
    },
    providerOptions: ["watsonx"],
    icon: "WatsonX.png",
    isOpenSource: false,
  },
  MistralLarge: {
    title: "Mistral Large",
    description:
      "Mistral Large, the most advanced Large Language Model (LLM) developed by Mistral Al, is an exceptionally powerful model.",
    params: {
      model: "mistralai/mistral-large",
      contextLength: 20_000,
      title: "Mistral Large",
    },
    providerOptions: ["watsonx"],
    icon: "mistral.png",
    isOpenSource: false,
  },
  MetaLlama3: {
    title: "Llama 3.1",
    description:
      "Llama 3 is an auto-regressive language model that uses an optimized transformer architecture.",
    params: {
      title: "Llama 3.1",
      model: "meta-llama/llama-3-1-8b-instruct",
      contextLength: 20_000,
    },
    icon: "meta.png",
    dimensions: [
      {
        name: "Parameter Count",
        description: "The number of parameters in the model",
        options: {
          "8b": {
            model: "meta-llama/llama-3-1-8b-instruct",
            title: "Llama 3.1 8b",
          },
          "70b": {
            model: "meta-llama/llama-3-1-70b-instruct",
            title: "Llama 3.1 70b",
          },
        },
      },
    ],
    providerOptions: ["watsonx"],
    isOpenSource: false,
  },
  vertexMistralLarge: {
    title: "Mistral Large",
    description:
      "Mistral's flagship model that's ideal for complex tasks that require large reasoning capabilities or are highly specialized (Synthetic Text Generation, Code Generation, RAG, or Agents).",
    params: {
      title: "Mistral Large",
      model: "mistral-large",
      contextLength: 32000,
    },
    icon: "mistral.png",
    providerOptions: ["vertexai"],
    isOpenSource: false,
  },
  // OpenAI Models via Ask Sage

  asksagenovalite: {
    title: "Nova Lite*",
    description: "AWS Gov Nova Lite model.",
    params: {
      model: "aws-bedrock-nova-lite-gov",
      contextLength: 300_000,
      title: "Nova Lite*",
      apiKey: "",
    },
    providerOptions: ["askSage"],
    icon: "aws.png",
    isOpenSource: false,
  },
  asksagegroqllama33: {
    title: "Llama 3.3",
    description: "Llama-3.3 is a large language model customized by Groq.",
    params: {
      title: "Llama 3.3",
      model: "groq-llama33",
      contextLength: 128_000,
      apiKey: "",
    },
    providerOptions: ["askSage"],
    icon: "groq.png",
    isOpenSource: true,
  },
  asksagegroq70b: {
    title: "Groq-70B",
    description: "A large language model customized by Groq.",
    params: {
      title: "Groq-70B",
      model: "groq-70b",
      contextLength: 8_192,
      apiKey: "",
    },
    providerOptions: ["askSage"],
    icon: "groq.png",
    isOpenSource: true,
  },
  asksagegrok4: {
    title: "Grok 4",
    description:
      "xAI's latest and greatest flagship model, offering strong performance in natural language, math and reasoning.",
    params: {
      title: "Grok 4",
      model: "xai-grok",
      contextLength: 256_000,
      apiKey: "",
    },
    icon: "xAI.png",
    providerOptions: ["askSage"],
    isOpenSource: false,
  },
  gpt5_4Mini: {
    title: "GPT-5.4 Mini",
    description:
      "OpenAI's strongest mini model for coding, computer use, and high-volume workloads.",
    params: {
      model: "gpt-5.4-mini",
      contextLength: 400_000,
      completionOptions: { maxTokens: 128_000 },
      title: "GPT-5.4 Mini",
    },
    providerOptions: ["openai"],
    icon: "openai.png",
    isOpenSource: false,
  },
  gemini25FlashLite: {
    title: "Gemini 2.5 Flash Lite",
    description: "Lightweight Gemini model optimized for low-latency tasks.",
    params: {
      title: "Gemini 2.5 Flash Lite",
      model: "gemini-2.5-flash-lite",
      contextLength: 1_048_576,
      apiKey: "<API_KEY>",
    },
    icon: "gemini.png",
    providerOptions: ["gemini"],
    isOpenSource: false,
  },
  gemini3FlashPreview: {
    title: "Gemini 3 Flash",
    description: "High-speed thinking model for agentic workflows and coding.",
    params: {
      title: "Gemini 3 Flash",
      model: "gemini-3-flash-preview",
      contextLength: 1_048_576,
      apiKey: "<API_KEY>",
    },
    icon: "gemini.png",
    providerOptions: ["gemini"],
    isOpenSource: false,
  },
  ministral8b: {
    title: "Ministral 8B",
    description: "Mistral's small model balancing capability and efficiency.",
    params: {
      title: "Ministral 8B",
      model: "ministral-8b-latest",
      contextLength: 128_000,
    },
    icon: "mistral.png",
    providerOptions: ["mistral"],
    isOpenSource: false,
  },
  gemma2_2b: {
    title: "Gemma 2 2b IT",
    description:
      "Gemma 2 IT instruction-tuned language model developed by Google, designed for tasks like question answering, summarization, and reasoning.",
    params: {
      title: "Gemma 2 2b IT",
      model: "gemma2-2b-it",
      contextLength: 4000,
    },
    isOpenSource: true,
  },
  gemma2_9b: {
    title: "Gemma 2 9b IT",
    description:
      "Gemma 2 IT instruction-tuned language model developed by Google, designed for tasks like question answering, summarization, and reasoning.",
    params: {
      title: "Gemma 2 9b IT",
      model: "gemma2-9b-it",
      contextLength: 8000,
    },
    isOpenSource: true,
  },
  gemma4: {
    title: "Gemma 4",
    description:
      "Gemma 4 is a multimodal open model from Google, supporting text, image, tool use, and up to 128k context.",
    params: {
      title: "Gemma 4",
      model: "gemma4",
      contextLength: 128_000,
    },
    icon: "gemini.png",
    providerOptions: ["ollama"],
    isOpenSource: true,
  },
  phi3mini: {
    title: "Microsoft Phi 3 mini",
    description:
      "Phi 3 Mini is a 3.8-billion-parameter language model developed by Microsoft.",
    params: {
      title: "Microsoft Phi 3 mini",
      model: "phi-3-mini",
      contextLength: 4000,
    },
    isOpenSource: true,
  },
  phi3medium: {
    title: "Microsoft Phi 3 medium",
    description:
      "Phi 3 Medium is a 14-billion-parameter language model developed by Microsoft.",
    params: {
      title: "Microsoft Phi 3 medium",
      model: "phi-3-medium",
      contextLength: 128_000,
    },
    isOpenSource: true,
  },
  olmo7b: {
    title: "OLMo 7b",
    description:
      "OLMo 7B Instruct HF is a 7-billion-parameter language model by the Allen Institute for AI, fine-tuned for question answering tasks.",
    params: {
      title: "OLMo 7b",
      model: "olmo-7b",
      contextLength: 2000,
    },
    isOpenSource: true,
  },
  minimaxM27: {
    title: "MiniMax M2.7",
    description:
      "Latest flagship model with enhanced reasoning and coding capabilities. 204K context window.",
    params: {
      title: "MiniMax M2.7",
      model: "MiniMax-M2.7",
      contextLength: 204_800,
    },
    providerOptions: ["minimax"],
    isOpenSource: false,
  },
  minimaxM27Highspeed: {
    title: "MiniMax M2.7 Highspeed",
    description:
      "High-speed version of M2.7 for low-latency scenarios. 204K context window.",
    params: {
      title: "MiniMax M2.7 Highspeed",
      model: "MiniMax-M2.7-highspeed",
      contextLength: 204_800,
    },
    providerOptions: ["minimax"],
    isOpenSource: false,
  },
  minimaxM25: {
    title: "MiniMax M2.5",
    description:
      "Peak performance with ultimate value. Excels at complex reasoning, code generation, and multi-step tasks with a 204K context window.",
    params: {
      title: "MiniMax M2.5",
      model: "MiniMax-M2.5",
      contextLength: 204_800,
    },
    providerOptions: ["minimax"],
    isOpenSource: false,
  },
  minimaxM25Highspeed: {
    title: "MiniMax M2.5 Highspeed",
    description:
      "Same performance as M2.5, faster and more agile for latency-sensitive tasks with a 204K context window.",
    params: {
      title: "MiniMax M2.5 Highspeed",
      model: "MiniMax-M2.5-highspeed",
      contextLength: 204_800,
    },
    providerOptions: ["minimax"],
    isOpenSource: false,
  },

  // ClawRouter Models
  clawrouterAuto: {
    title: "ClawRouter Auto",
    description:
      "Automatic model selection - routes to the cheapest capable model based on prompt complexity (78-96% cost savings)",
    params: {
      title: "ClawRouter Auto",
      model: "blockrun/auto",
      contextLength: 128_000,
    },
    icon: "clawrouter.png",
    providerOptions: ["clawrouter"],
    isOpenSource: true,
  },
  clawrouterFree: {
    title: "ClawRouter Free",
    description:
      "Free tier model routing - automatically selects from available free models",
    params: {
      title: "ClawRouter Free",
      model: "blockrun/free",
      contextLength: 32_000,
    },
    icon: "clawrouter.png",
    providerOptions: ["clawrouter"],
    isOpenSource: true,
  },
  clawrouterEco: {
    title: "ClawRouter Eco",
    description:
      "Economy tier model routing - balances cost and capability for everyday tasks",
    params: {
      title: "ClawRouter Eco",
      model: "blockrun/eco",
      contextLength: 64_000,
    },
    icon: "clawrouter.png",
    providerOptions: ["clawrouter"],
    isOpenSource: true,
  },
  clawrouterPremium: {
    title: "ClawRouter Premium",
    description:
      "Premium tier - routes to best quality models (Claude Opus, GPT-5.4 Pro) for mission-critical tasks",
    params: {
      title: "ClawRouter Premium",
      model: "blockrun/premium",
      contextLength: 200_000,
    },
    icon: "clawrouter.png",
    providerOptions: ["clawrouter"],
    isOpenSource: true,
  },

  // Current presets (ids checked against vendor docs 2026-11-04). Limits are
  // only set where confirmed; otherwise the model's metadata or defaults apply.
  gpt6Astra: {
    title: "GPT-6 Astra",
    description: "OpenAI's GPT-6 Astra model.",
    params: {
      title: "GPT-6 Astra",
      model: "gpt-6-astra",
      contextLength: 1_050_000,
      completionOptions: { maxTokens: 128_000 },
    },
    icon: "openai.png",
    providerOptions: ["openai"],
    isOpenSource: false,
  },
  gpt61Sol: {
    title: "GPT-6.1 Sol",
    description: "OpenAI's GPT-6.1 Sol model.",
    params: {
      title: "GPT-6.1 Sol",
      model: "gpt-6.1-sol",
      contextLength: 1_050_000,
      completionOptions: { maxTokens: 128_000 },
    },
    icon: "openai.png",
    providerOptions: ["openai"],
    isOpenSource: false,
  },
  gpt61Terra: {
    title: "GPT-6.1 Terra",
    description: "OpenAI's GPT-6.1 Terra model.",
    params: {
      title: "GPT-6.1 Terra",
      model: "gpt-6.1-terra",
      contextLength: 1_050_000,
      completionOptions: { maxTokens: 128_000 },
    },
    icon: "openai.png",
    providerOptions: ["openai"],
    isOpenSource: false,
  },
  gpt6Luna: {
    title: "GPT-6 Luna",
    description: "OpenAI's GPT-6 Luna model.",
    params: {
      title: "GPT-6 Luna",
      model: "gpt-6-luna",
      contextLength: 1_050_000,
      completionOptions: { maxTokens: 128_000 },
    },
    icon: "openai.png",
    providerOptions: ["openai"],
    isOpenSource: false,
  },
  gpt5_5: {
    title: "GPT-5.5",
    description: "OpenAI's GPT-5.5 model with a 1M context window.",
    params: {
      title: "GPT-5.5",
      model: "gpt-5.5",
      contextLength: 1_050_000,
      completionOptions: { maxTokens: 128_000 },
    },
    icon: "openai.png",
    providerOptions: ["openai"],
    isOpenSource: false,
  },
  deepseekV4Pro: {
    title: "DeepSeek V4 Pro",
    description: "DeepSeek's V4 Pro model.",
    refUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    params: {
      title: "DeepSeek V4 Pro",
      model: "deepseek-v4-pro",
    },
    icon: "deepseek.png",
    providerOptions: ["deepseek"],
    isOpenSource: false,
  },
  deepseekFlash: {
    title: "DeepSeek Flash",
    description: "DeepSeek's fast, low-cost Flash model.",
    refUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    params: {
      title: "DeepSeek Flash",
      model: "deepseek-flash",
    },
    icon: "deepseek.png",
    providerOptions: ["deepseek"],
    isOpenSource: false,
  },
  gemini4Argon: {
    title: "Gemini 4 Argon",
    description: "Google's Gemini 4 Argon model.",
    params: {
      title: "Gemini 4 Argon",
      model: "gemini-4-argon",
      apiKey: "<API_KEY>",
    },
    icon: "gemini.png",
    providerOptions: ["gemini"],
    isOpenSource: false,
  },
  gemini38Flash: {
    title: "Gemini 3.8 Flash",
    description: "Google's Gemini 3.8 Flash model.",
    params: {
      title: "Gemini 3.8 Flash",
      model: "gemini-3.8-flash",
      apiKey: "<API_KEY>",
    },
    icon: "gemini.png",
    providerOptions: ["gemini"],
    isOpenSource: false,
  },
  gemini36Flash: {
    title: "Gemini 3.6 Flash",
    description: "Google's Gemini 3.6 Flash model.",
    params: {
      title: "Gemini 3.6 Flash",
      model: "gemini-3.6-flash",
      apiKey: "<API_KEY>",
    },
    icon: "gemini.png",
    providerOptions: ["gemini"],
    isOpenSource: false,
  },
  gemini35FlashLite: {
    title: "Gemini 3.5 Flash Lite",
    description: "Google's Gemini 3.5 Flash Lite model for high-volume tasks.",
    params: {
      title: "Gemini 3.5 Flash Lite",
      model: "gemini-3.5-flash-lite",
      apiKey: "<API_KEY>",
    },
    icon: "gemini.png",
    providerOptions: ["gemini"],
    isOpenSource: false,
  },
  grok47: {
    title: "Grok 4.7",
    description: "xAI's Grok 4.7 model.",
    refUrl: "https://docs.x.ai/docs/models",
    params: {
      title: "Grok 4.7",
      model: "grok-4.7",
    },
    icon: "xAI.png",
    providerOptions: ["xAI"],
    isOpenSource: false,
  },
  grok46: {
    title: "Grok 4.6",
    description: "xAI's Grok 4.6 model.",
    refUrl: "https://docs.x.ai/docs/models",
    params: {
      title: "Grok 4.6",
      model: "grok-4.6",
    },
    icon: "xAI.png",
    providerOptions: ["xAI"],
    isOpenSource: false,
  },
  grok43: {
    title: "Grok 4.3",
    description: "xAI's Grok 4.3 model.",
    refUrl: "https://docs.x.ai/docs/models",
    params: {
      title: "Grok 4.3",
      model: "grok-4.3",
    },
    icon: "xAI.png",
    providerOptions: ["xAI"],
    isOpenSource: false,
  },
  grok420Reasoning: {
    title: "Grok 4.20 Reasoning",
    description: "xAI's Grok 4.20 reasoning model.",
    refUrl: "https://docs.x.ai/docs/models",
    params: {
      title: "Grok 4.20 Reasoning",
      model: "grok-4.20-0309-reasoning",
    },
    icon: "xAI.png",
    providerOptions: ["xAI"],
    isOpenSource: false,
  },
  grokBuild01: {
    title: "Grok Build 0.1",
    description: "xAI's Grok Build model for agentic coding.",
    refUrl: "https://docs.x.ai/docs/models",
    params: {
      title: "Grok Build 0.1",
      model: "grok-build-0.1",
    },
    icon: "xAI.png",
    providerOptions: ["xAI"],
    isOpenSource: false,
  },
  mistralLarge4: {
    title: "Mistral Large 4",
    description:
      "Mistral's flagship model for complex reasoning, coding and agents.",
    params: {
      title: "Mistral Large 4",
      model: "mistral-large-4",
    },
    icon: "mistral.png",
    providerOptions: ["mistral"],
    isOpenSource: false,
  },

  AUTODETECT: {
    title: "Autodetect",
    description:
      "Automatically populate the model list by calling the /models endpoint of the server",
    params: {
      model: "AUTODETECT",
    } as any,
    providerOptions: [],
    isOpenSource: false,
  },

  // CometAPI Models

  // GPT series models via CometAPI

  // Claude series models via CometAPI
  asksagegpt52: {
    title: "GPT-5.2*",
    description: "OpenAI's GPT-5.2 model",
    params: {
      model: "gpt-5.2",
      contextLength: 400_000,
      maxTokens: 200_000,
      title: "GPT-5.2*",
      apiKey: "",
    },
    providerOptions: ["askSage"],
    icon: "openai.png",
    isOpenSource: false,
  },
  asksagegroqllama4scout: {
    title: "Llama 4 Scout",
    description: "Llama-4 Scout is a large language model customized by Groq.",
    params: {
      title: "Llama 4 Scout",
      model: "groq-llama4-scout",
      contextLength: 128_000,
      apiKey: "",
    },
    providerOptions: ["askSage"],
    icon: "groq.png",
    isOpenSource: true,
  },

  // Gemini series models via CometAPI
  cometapiGemini25FlashLite: {
    title: "Gemini 2.5 Flash Lite",
    description:
      "Gemini 2.5 Flash Lite via CometAPI - lightweight version for faster responses.",
    params: {
      model: "gemini-2.5-flash-lite",
      contextLength: 8_000,
      title: "Gemini 2.5 Flash Lite",
      apiKey: "",
    },
    providerOptions: ["cometapi"],
    icon: "cometapi.png",
    isOpenSource: false,
  },

  // Grok series models via CometAPI

  // DeepSeek series models via CometAPI (additional)
  cometapiDeepseekV31: {
    title: "DeepSeek V3.1",
    description:
      "DeepSeek V3.1 via CometAPI - enhanced version with improved performance.",
    params: {
      model: "deepseek-v3.1",
      contextLength: 128_000,
      title: "DeepSeek V3.1",
      apiKey: "",
    },
    providerOptions: ["cometapi"],
    icon: "cometapi.png",
    isOpenSource: false,
  },
  cometapiDeepseekR10528: {
    title: "DeepSeek R1",
    description:
      "DeepSeek R1 via CometAPI - reasoning model with enhanced problem-solving capabilities.",
    params: {
      model: "deepseek-r1-0528",
      contextLength: 64_000,
      title: "DeepSeek R1",
      apiKey: "",
    },
    providerOptions: ["cometapi"],
    icon: "cometapi.png",
    isOpenSource: false,
  },

  // Qwen series models via CometAPI
  cometapiQwen330BA3B: {
    title: "Qwen 3 30B A3B",
    description:
      "Qwen 3 30B A3B via CometAPI - Alibaba's advanced language model with 30B parameters.",
    params: {
      model: "qwen3-30b-a3b",
      contextLength: 128_000,
      title: "Qwen 3 30B A3B",
      apiKey: "",
    },
    providerOptions: ["cometapi"],
    icon: "cometapi.png",
    isOpenSource: false,
  },
  cometapiQwen3CoderPlus: {
    title: "Qwen 3 Coder Plus",
    description:
      "Qwen 3 Coder Plus via CometAPI - specialized coding model from Alibaba.",
    params: {
      model: "qwen3-coder-plus-2025-07-22",
      contextLength: 262_000,
      title: "Qwen 3 Coder Plus",
      apiKey: "",
    },
    providerOptions: ["cometapi"],
    icon: "cometapi.png",
    isOpenSource: false,
  },

  // Xiaomi Mimo models
  mimoV2Flash: {
    title: "mimo-v2-flash",
    description: "Xiaomi's fast and efficient language model",
    refUrl: "https://platform.xiaomimimo.com/",
    params: {
      title: "mimo-v2-flash",
      model: "mimo-v2-flash",
      contextLength: 128_000,
      apiKey: "",
    },
    providerOptions: ["mimo"],
    icon: "mimo.png",
    isOpenSource: false,
  },

  // Inception Labs models
  mercury2: {
    title: "Mercury 2",
    description:
      "Inception Labs' fastest reasoning LLM with 128k context, tool calling, and structured outputs.",
    refUrl: "https://docs.inceptionlabs.ai/",
    params: {
      title: "Mercury 2",
      model: "mercury-2",
      contextLength: 128_000,
    },
    providerOptions: ["inception"],
    icon: "inception.png",
    isOpenSource: false,
  },
};
