import { DevDataLogEvent, devDataVersionedSchemas } from "@nextcli/config-yaml";
import { z } from "zod";
import fs from "fs";
import path from "path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { IdeInfo, IdeSettings } from "..";
import { Core } from "../core";
import { getDevDataFilePath } from "../util/paths";
import { DataLogger, LOCAL_DEV_DATA_VERSION } from "./log";

// The schemas the logger writes with, at the version it writes
const localSchemas = (level: "all" | "noCode") =>
  devDataVersionedSchemas[LOCAL_DEV_DATA_VERSION][level];

// Only mock fetch, not fs
vi.mock("@nextcli/fetch");

const TEST_EVENT: DevDataLogEvent = {
  name: "tokensGenerated",
  data: {
    generatedTokens: 100,
    model: "gpt-4",
    promptTokens: 50,
    provider: "openai",
  },
};

const TEST_AGENT_INTERACTION_EVENT: DevDataLogEvent = {
  name: "chatInteraction",
  data: {
    prompt: "Hello, world!",
    completion: "Hello, world!",
    modelProvider: "openai",
    modelName: "gpt-4",
    modelTitle: "gpt-4",
    sessionId: "1234",
    tools: ["test-tool1"],
  },
};

const SCHEMA = "0.2.0";

describe("DataLogger", () => {
  let dataLogger: DataLogger;
  const tempDir = path.join(process.cwd(), "temp-test-data");
  const testFilePath = path.join(tempDir, "tokensGenerated-test.jsonl");

  // Create temp directory for test files
  beforeAll(() => {
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
  });

  // Clean up temp directory after tests
  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // The local log is off unless the test sets a level
    delete process.env.NEXTCLI_TRACE;

    // Remove test file if it exists
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }

    // Get singleton instance
    dataLogger = DataLogger.getInstance();

    // Mock core and required promises
    dataLogger.core = {
      configHandler: {
        loadConfig: vi.fn().mockResolvedValue({
          config: {
            data: [],
          },
        }),
        currentProfile: {
          profileDescription: {
            id: "test-profile-id",
          },
        },
      },
    } as unknown as Core;

    dataLogger.ideSettingsPromise = Promise.resolve({
      userToken: "test-user-token",
    } as IdeSettings);

    dataLogger.ideInfoPromise = Promise.resolve({
      name: "VSCode",
      version: "1.0.0",
      extensionVersion: "0.1.0",
    } as IdeInfo);
  });

  describe("getInstance", () => {
    it("should return the same instance when called multiple times", () => {
      const instance1 = DataLogger.getInstance();
      const instance2 = DataLogger.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("addBaseValues", () => {
    it("should add base values to event data based on schema", async () => {
      const mockZodSchema = {
        shape: {
          eventName: true,
          timestamp: true,
          schema: true,
          userAgent: true,
          selectedProfileId: true,
          userId: true,
        },
      };

      const result = await dataLogger.addBaseValues(
        { customField: "value" },
        "testEvent",
        SCHEMA,
        mockZodSchema as any,
      );

      expect(result).toEqual({
        customField: "value",
        eventName: "testEvent",
        timestamp: expect.any(String),
        schema: SCHEMA,
        userAgent: "VSCode/1.0.0 (NextCLI/0.1.0)",
        selectedProfileId: "test-profile-id",
        userId: "test-user-token",
      });
    });

    it("should not add fields not present in schema shape", async () => {
      const mockZodSchema = {
        shape: {
          eventName: true,
          // No other fields
        },
      };

      const result = await dataLogger.addBaseValues(
        { customField: "value" },
        "testEvent",
        SCHEMA,
        mockZodSchema as any,
      );

      expect(result).toEqual({
        customField: "value",
        eventName: "testEvent",
      });
    });
  });

  describe("logLocalData", () => {
    afterEach(() => {
      delete process.env.NEXTCLI_TRACE;
    });

    it("should actually write data to the local file", async () => {
      process.env.NEXTCLI_TRACE = "full";

      // Call the method to log data locally
      await dataLogger.logLocalData(TEST_EVENT);

      // Verify the file was created
      const filepath = getDevDataFilePath(TEST_EVENT.name, SCHEMA);
      expect(fs.existsSync(filepath)).toBe(true);

      // Read file contents and verify
      const fileContent = fs.readFileSync(filepath, "utf8");
      expect(fileContent).toContain('"generatedTokens":100');
      expect(fileContent).toContain('"model":"gpt-4"');
      expect(fileContent).toContain('"eventName":"tokensGenerated"');
    });

    it("should write agent interaction data to local file", async () => {
      process.env.NEXTCLI_TRACE = "full";

      // Call the method to log data locally
      await dataLogger.logLocalData(TEST_AGENT_INTERACTION_EVENT);

      // Verify the file was created
      const filepath = getDevDataFilePath(
        TEST_AGENT_INTERACTION_EVENT.name,
        SCHEMA,
      );
      expect(fs.existsSync(filepath)).toBe(true);

      // Read file contents and verify
      const fileContent = fs.readFileSync(filepath, "utf8");
      expect(fileContent).toContain('"eventName":"chatInteraction"');
      expect(fileContent).toContain('"prompt":"Hello, world!"');
      expect(fileContent).toContain('"completion":"Hello, world!"');
      expect(fileContent).toContain('"tools":["test-tool1"]');
    });
  });

  describe("local logging levels (NEXTCLI_TRACE)", () => {
    const chatFile = () => getDevDataFilePath("chatInteraction", SCHEMA);

    afterEach(() => {
      delete process.env.NEXTCLI_TRACE;
      for (const file of [
        chatFile(),
        getDevDataFilePath("tokensGenerated", SCHEMA),
      ]) {
        fs.rmSync(file, { force: true });
      }
    });

    it("writes no file and runs no schema parse when unset", async () => {
      // getDevDataFilePath creates the file's folder; start from none
      fs.rmSync(path.dirname(chatFile()), { recursive: true, force: true });
      const schema = localSchemas("all").chatInteraction as z.ZodObject<any>;
      const parseSpy = vi.spyOn(schema, "safeParse");

      await dataLogger.logDevData(TEST_AGENT_INTERACTION_EVENT);

      expect(parseSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(chatFile())).toBe(false);
    });

    it("basic writes the noCode line, without prompt or completion", async () => {
      process.env.NEXTCLI_TRACE = "basic";

      await dataLogger.logDevData(TEST_AGENT_INTERACTION_EVENT);

      const line = JSON.parse(fs.readFileSync(chatFile(), "utf8").trim());
      expect(line).not.toHaveProperty("prompt");
      expect(line).not.toHaveProperty("completion");
      expect(line.eventName).toBe("chatInteraction");
      expect(line.tools).toEqual(["test-tool1"]);
      const noCode = localSchemas("noCode").chatInteraction as z.ZodObject<any>;
      expect(noCode.safeParse(line).success).toBe(true);
    });

    it("full writes the same content as the all level", async () => {
      process.env.NEXTCLI_TRACE = "full";

      await dataLogger.logDevData(TEST_AGENT_INTERACTION_EVENT);

      const line = JSON.parse(fs.readFileSync(chatFile(), "utf8").trim());
      expect(line.prompt).toBe("Hello, world!");
      expect(line.completion).toBe("Hello, world!");
      const all = localSchemas("all").chatInteraction as z.ZodObject<any>;
      expect(all.safeParse(line).success).toBe(true);
    });

    it("an unknown value stays off and warns once", async () => {
      process.env.NEXTCLI_TRACE = "loud";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await dataLogger.logDevData(TEST_AGENT_INTERACTION_EVENT);
      await dataLogger.logDevData(TEST_AGENT_INTERACTION_EVENT);

      expect(fs.existsSync(chatFile())).toBe(false);
      const traceWarnings = warnSpy.mock.calls.filter((call) =>
        String(call[0]).includes("NEXTCLI_TRACE"),
      );
      expect(traceWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });

    it("accepts the value in any case and with spaces", async () => {
      process.env.NEXTCLI_TRACE = " Basic ";

      await dataLogger.logDevData(TEST_AGENT_INTERACTION_EVENT);

      const line = JSON.parse(fs.readFileSync(chatFile(), "utf8").trim());
      expect(line).not.toHaveProperty("prompt");
    });

    it("still sends to a configured destination when local logging is off", async () => {
      const logToOneDestinationSpy = vi
        .spyOn(dataLogger, "logToOneDestination")
        .mockResolvedValue();
      dataLogger.core!.configHandler.loadConfig = vi.fn().mockResolvedValue({
        config: {
          data: [{ destination: "https://example.com/logs", schema: SCHEMA }],
        },
      });

      await dataLogger.logDevData(TEST_EVENT);

      expect(fs.existsSync(getDevDataFilePath(TEST_EVENT.name, SCHEMA))).toBe(
        false,
      );
      expect(logToOneDestinationSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("logDevData", () => {
    it("should log data locally and to configured destinations", async () => {
      // Spy on logLocalData and logToOneDestination
      const logLocalDataSpy = vi
        .spyOn(dataLogger, "logLocalData")
        .mockResolvedValue();
      const logToOneDestinationSpy = vi
        .spyOn(dataLogger, "logToOneDestination")
        .mockResolvedValue();

      // Mock config with multiple data destinations
      const mockConfig = {
        config: {
          data: [
            { destination: "https://example.com/logs", schema: SCHEMA },
            { destination: "file:///logs", schema: SCHEMA },
          ],
        },
      };

      dataLogger.core!.configHandler.loadConfig = vi
        .fn()
        .mockResolvedValue(mockConfig);

      await dataLogger.logDevData(TEST_EVENT);

      expect(logLocalDataSpy).toHaveBeenCalledWith(TEST_EVENT);
      expect(logToOneDestinationSpy).toHaveBeenCalledTimes(2);
    });
  });
});
