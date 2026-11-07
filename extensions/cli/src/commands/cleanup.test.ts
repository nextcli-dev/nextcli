import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { find, remove, question } = vi.hoisted(() => ({
  find: vi.fn(),
  remove: vi.fn(),
  question: vi.fn(),
}));

vi.mock("core/indexing/legacyEmbeddingsData.js", () => ({
  findLegacyEmbeddingsData: find,
  removeLegacyEmbeddingsData: remove,
  formatBytes: (bytes: number) => `${bytes} B`,
}));

vi.mock("node:readline/promises", () => ({
  default: {
    createInterface: () => ({ question, close: vi.fn() }),
  },
}));

import { cleanupCommand } from "./cleanup.js";

const FOUND = {
  files: [{ name: "lancedb", bytes: 1000 }],
  indexRows: 3,
  indexBytes: 31,
  totalBytes: 1031,
};

let output: string[];
let stdinIsTTY: boolean | undefined;

beforeEach(() => {
  output = [];
  vi.spyOn(console, "log").mockImplementation((line) => output.push(line));
  vi.spyOn(console, "error").mockImplementation((line) => output.push(line));
  stdinIsTTY = process.stdin.isTTY;
  process.exitCode = undefined;
  find.mockReset();
  remove.mockReset();
  question.mockReset();
});

afterEach(() => {
  process.stdin.isTTY = stdinIsTTY as boolean;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("cn cleanup", () => {
  it("says there is nothing to clean up", async () => {
    find.mockResolvedValue(undefined);

    await cleanupCommand();

    expect(output.join("\n")).toContain("Nothing to clean up");
    expect(remove).not.toHaveBeenCalled();
  });

  it("lists what it found and deletes it with --yes, without asking", async () => {
    find.mockResolvedValue(FOUND);

    await cleanupCommand({ yes: true });

    const text = output.join("\n");
    expect(text).toContain("lancedb  1000 B");
    expect(text).toContain("index.sqlite: 3 rows, about 31 B");
    expect(text).toContain("Total: 1031 B");
    expect(question).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(text).toContain("Deleted 1031 B.");
  });

  it("refuses without --yes when there is no terminal to ask in", async () => {
    find.mockResolvedValue(FOUND);
    process.stdin.isTTY = false;

    await cleanupCommand();

    expect(remove).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(output.join("\n")).toContain("cn cleanup --yes");
  });

  it("deletes after the user answers y, and keeps the data otherwise", async () => {
    find.mockResolvedValue(FOUND);
    process.stdin.isTTY = true;

    question.mockResolvedValue("y");
    await cleanupCommand();
    expect(remove).toHaveBeenCalledTimes(1);

    question.mockResolvedValue("");
    await cleanupCommand();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(output.join("\n")).toContain("Kept.");
  });
});
