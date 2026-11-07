import { InvalidArgumentError } from "commander";
import { describe, expect, it } from "vitest";

import { parseEffortOption } from "./shared-options.js";

describe("--effort", () => {
  it("accepts known levels in any case", () => {
    expect(parseEffortOption("High")).toBe("high");
    expect(parseEffortOption(" xhigh ")).toBe("xhigh");
  });

  it("rejects unknown levels", () => {
    expect(() => parseEffortOption("bogus")).toThrow(InvalidArgumentError);
    expect(() => parseEffortOption("bogus")).toThrow(/Unknown effort "bogus"/);
  });
});
