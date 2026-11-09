import { afterEach, describe, expect, it, vi } from "vitest";

async function loadLogger(envLevel?: string) {
  vi.resetModules();
  if (envLevel === undefined) {
    delete process.env.NEXTCLI_LOG_LEVEL;
  } else {
    process.env.NEXTCLI_LOG_LEVEL = envLevel;
  }
  return (await import("./logger.js")).logger;
}

describe("logger levels", () => {
  afterEach(() => {
    delete process.env.NEXTCLI_LOG_LEVEL;
  });

  it("starts at info", async () => {
    const logger = await loadLogger();

    expect(logger.isLevelEnabled("info")).toBe(true);
    expect(logger.isLevelEnabled("verbose")).toBe(false);
  });

  it("starts at NEXTCLI_LOG_LEVEL, in any case", async () => {
    const logger = await loadLogger("Verbose");

    expect(logger.isLevelEnabled("verbose")).toBe(true);
    expect(logger.isLevelEnabled("debug")).toBe(false);
  });

  it("uses info for an unknown NEXTCLI_LOG_LEVEL and says so on stderr", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const logger = await loadLogger("loud");

    expect(logger.isLevelEnabled("info")).toBe(true);
    expect(logger.isLevelEnabled("verbose")).toBe(false);
    expect(String(stderr.mock.calls[0][0])).toContain(
      'Unknown NEXTCLI_LOG_LEVEL "loud"',
    );
    stderr.mockRestore();
  });

  it("puts verbose between info and debug, and trace last", async () => {
    const logger = await loadLogger();

    logger.setLevel("debug");
    expect(logger.isLevelEnabled("verbose")).toBe(true);
    expect(logger.isLevelEnabled("trace")).toBe(false);

    logger.setLevel("trace");
    expect(logger.isLevelEnabled("trace")).toBe(true);
  });

  it("doesn't read the metadata of a level that is off", async () => {
    const logger = await loadLogger();
    const read = vi.fn(() => "chunk");
    const meta = {
      get chunk() {
        return read();
      },
    };

    logger.debug("Received chunk", meta);
    expect(read).not.toHaveBeenCalled();

    logger.setLevel("debug");
    logger.debug("Received chunk", meta);
    expect(read).toHaveBeenCalled();
  });
});
