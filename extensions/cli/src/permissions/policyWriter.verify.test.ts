import { generatePolicyRules } from "./policyWriter.js";

describe("policyWriter verification", () => {
  it("should return display names for all tools", () => {
    expect(generatePolicyRules("Edit", { filepath: "test.txt" })).toEqual([
      "Edit",
    ]);
    expect(generatePolicyRules("Write", { filepath: "test.txt" })).toEqual([
      "Write",
    ]);
    expect(generatePolicyRules("Read", { filepath: "test.txt" })).toEqual([
      "Read",
    ]);
    expect(generatePolicyRules("Bash", { command: "ls -la" })).toEqual([
      "Bash(ls -la)",
    ]);
  });

  it("should use exact tool names without case normalization", () => {
    expect(generatePolicyRules("edit", { filepath: "test.txt" })).toEqual([
      "edit",
    ]);
    expect(generatePolicyRules("EDIT", { filepath: "test.txt" })).toEqual([
      "EDIT",
    ]);
  });
});
