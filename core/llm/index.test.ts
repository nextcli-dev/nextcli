import {
  ChatMessage,
  CompletionOptions,
  LLMInteractionItem,
  LLMOptions,
  Tool,
} from "..";

import { allModelProviders } from "@nextcli/llm-info";
import { LlmInfo } from "@nextcli/llm-info/dist/types";
import { BaseLLM } from ".";
import { DEFAULT_CONTEXT_LENGTH } from "./constants";
import { LLMClasses } from "./llms";
import { LLMLogger } from "./logger";

class DummyLLM extends BaseLLM {
  static providerName = "openai";
  static defaultOptions: Partial<LLMOptions> = {
    model: "dummy-model",
    contextLength: 200_000,
    completionOptions: {
      model: "some-model",
      maxTokens: 4096,
    },
    apiBase: "https://api.test-api-dummy.com/v1/",
  };
}
describe("BaseLLM", () => {
  let baseLLM: BaseLLM;

  beforeEach(() => {
    const options: LLMOptions = {
      model: "dummy-model",
    };
    // Instantiate a DummyLLM instance
    baseLLM = new DummyLLM(options);
  });

  describe("BaseLLM constructor", () => {
    it("should correctly initialize with given options", () => {
      const templatMessagesFunction = (messages: ChatMessage[]) => {
        return messages[0]?.content.toString() ?? "";
      };
      const llmLogger = new LLMLogger();
      const options: LLMOptions = {
        model: "gpt-3.5-turbo",
        uniqueId: "testId",
        contextLength: 1024,
        completionOptions: {
          model: "some-model",
          maxTokens: 150,
        },
        requestOptions: {},
        promptTemplates: {},
        templateMessages: templatMessagesFunction,
        logger: llmLogger,
        llmRequestHook: () => {},
        apiKey: "testApiKey",
        aiGatewaySlug: "testSlug",
        apiBase: "https://api.example.com",
        accountId: "testAccountId",
        deployment: "davinci",
        apiVersion: "v1",
        apiType: "public",
        region: "us",
        projectId: "testProjectId",
      };

      const instance = new DummyLLM(options);

      expect(instance.title).toBeDefined();
      expect(instance.uniqueId).toBe("testId");
      expect(instance.model).toBe("gpt-3.5-turbo");
      expect(instance.contextLength).toBe(1024);
      expect(instance.completionOptions.maxTokens).toBe(150);
      expect(instance.requestOptions).toEqual({});
      expect(instance.promptTemplates).toEqual({});
      expect(instance.templateMessages).toEqual(templatMessagesFunction);
      expect(instance.logger).toBe(llmLogger);
      expect(instance.apiKey).toBe("testApiKey");
      expect(instance.aiGatewaySlug).toBe("testSlug");
      expect(instance.apiBase).toBe("https://api.example.com/");
      expect(instance.accountId).toBe("testAccountId");
      expect(instance.deployment).toBe("davinci");
      expect(instance.apiVersion).toBe("v1");
      expect(instance.apiType).toBe("public");
      expect(instance.region).toBe("us");
      expect(instance.projectId).toBe("testProjectId");
    });
  });

  test("model should return correct provider model", () => {
    expect(baseLLM.model).toBe("dummy-model");
  });

  test("supportsFim should always return false", () => {
    expect(baseLLM.supportsFim()).toBe(false);
  });

  describe("supportsImages", () => {
    test("should return true when modelSupportsImages returns true", () => {
      baseLLM.model = "gpt-4-vision";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "fancy-vision-model";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "gemma3:4b";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "google/gemma-3-270m";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "gemma4:31b";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "google/gemma-4-31b-it";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "foo/paligemma-custom-100";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "foo/medgemma_4b_it_16Q";
      expect(baseLLM.supportsImages()).toBe(true);

      baseLLM.model = "qwen2.5vl";
      expect(baseLLM.supportsImages()).toBe(true);
    });

    test("should return false when modelSupportsImages returns false", () => {
      expect(baseLLM.supportsImages()).toBe(false);

      baseLLM.model = "gemma3n";
      expect(baseLLM.supportsImages()).toBe(false);
    });
  });

  describe("supportsCompletions", () => {
    test("should return correctly under specific conditions", () => {
      // Mocking properties and scenarios to match the conditions in supportsCompletions
      baseLLM.apiBase = "api.groq.com";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = "integrate.api.nvidia.com";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = "api.mistral.ai";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = ":1337";
      expect(baseLLM.supportsCompletions()).toBe(false);

      baseLLM.apiBase = "something:3000";
      expect(baseLLM.supportsCompletions()).toBe(true);
    });
  });
  describe("supportsPrefill", () => {
    test("should return correctly under specific conditions", () => {
      expect(baseLLM.supportsPrefill()).toBe(false);

      class PrefillLLM extends BaseLLM {
        static providerName = "ollama";
      }
      const prefillLLM = new PrefillLLM({ model: "some-model" });
      expect(prefillLLM.supportsPrefill()).toBe(true);
    });
  });
  describe("fetch", () => {
    // TODO: Implement tests for fetch method
  });
  describe("*_streamFim", () => {
    // TODO: Implement tests for *_streamFim method
  });
  describe("complete", () => {
    // TODO: Implement tests for complete method
  });
  describe("*streamChat", () => {
    // Records the options streamChat passes down, then yields one chunk.
    class CaptureLLM extends BaseLLM {
      static providerName = "mock";
      lastOptions?: CompletionOptions;
      constructor(options: LLMOptions) {
        super(options);
        // Use the chat path, not prompt templating (as MockLLM does)
        this.templateMessages = undefined;
      }
      protected async *_streamChat(
        _messages: ChatMessage[],
        _signal: AbortSignal,
        options: CompletionOptions,
      ): AsyncGenerator<ChatMessage> {
        this.lastOptions = options;
        yield { role: "assistant", content: "ok" };
      }
    }

    const tool = (name: string, description: string) =>
      ({
        type: "function",
        displayTitle: name,
        readonly: true,
        group: "test",
        function: { name, description, parameters: {} },
      }) as unknown as Tool;

    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];

    async function drain(llm: BaseLLM, options = {}) {
      const chunks: ChatMessage[] = [];
      for await (const chunk of llm.streamChat(
        messages,
        new AbortController().signal,
        options,
      )) {
        chunks.push(chunk);
      }
      return chunks;
    }

    it("passes tools through unchanged without tool overrides", async () => {
      const llm = new CaptureLLM({ model: "m" });
      const tools = [tool("read_file", "Read a file")];
      await drain(llm, { tools });
      expect(llm.lastOptions?.tools).toEqual(tools);
    });

    it("applies tool overrides and warns about unknown tool names", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const llm = new CaptureLLM({
        model: "m",
        toolOverrides: [
          { name: "read_file", description: "Overridden" },
          { name: "run_terminal_command", disabled: true },
          { name: "no_such_tool", description: "x" },
        ],
      });
      await drain(llm, {
        tools: [
          tool("read_file", "Read a file"),
          tool("run_terminal_command", "Run a command"),
        ],
      });
      const names = llm.lastOptions?.tools?.map((t) => t.function.name);
      expect(names).toEqual(["read_file"]);
      expect(llm.lastOptions?.tools?.[0].function.description).toBe(
        "Overridden",
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Tool override warning"),
      );
      warn.mockRestore();
    });

    it("logs startChat and calls the request hook when logging is on", async () => {
      const logger = new LLMLogger();
      const items: LLMInteractionItem[] = [];
      logger.onLogItem((item) => items.push(item));
      const llmRequestHook = jest.fn();
      const llm = new CaptureLLM({ model: "m", logger, llmRequestHook });
      await drain(llm);
      const start = items.filter((i) => i.kind === "startChat");
      // Existing behavior: on the provider (_streamChat) path, streamChat logs
      // startChat and calls the hook once up front and once more before the
      // request. Update these counts if that duplicate is removed.
      expect(start).toHaveLength(2);
      for (const item of start) {
        expect(item).toMatchObject({ provider: "mock", messages });
      }
      expect(llmRequestHook).toHaveBeenCalledTimes(2);
      expect(llmRequestHook).toHaveBeenCalledWith("m", expect.any(String));
    });

    it("does not log or call the request hook when logging is off", async () => {
      const logger = new LLMLogger();
      const items: LLMInteractionItem[] = [];
      logger.onLogItem((item) => items.push(item));
      const llmRequestHook = jest.fn();
      const llm = new CaptureLLM({ model: "m", logger, llmRequestHook });
      await drain(llm, { log: false });
      expect(items).toHaveLength(0);
      expect(llmRequestHook).not.toHaveBeenCalled();
    });
  });

  describe("default context length", () => {
    allModelProviders.map((modelProvider) => {
      const LLMClass = LLMClasses.find(
        (llm) => llm.providerName === modelProvider.id,
      );
      if (!LLMClass) {
        throw new Error(`did not find LLM provider for ${modelProvider.id}`);
      }
      const testContextLength = (llmInfo: LlmInfo) => () => {
        const llm = new LLMClass({ model: llmInfo.model, apiKey: "test-key" });
        if (llmInfo.contextLength) {
          expect(llm.contextLength).toEqual(llmInfo.contextLength);
        } else {
          expect(llm.contextLength).toEqual(DEFAULT_CONTEXT_LENGTH);
        }
      };
      describe(`${modelProvider.id}`, () => {
        for (const llmInfo of modelProvider.models) {
          test(
            `should have correct context length for ${llmInfo.model}`,
            testContextLength(llmInfo),
          );
        }
      });
    });
  });
});
