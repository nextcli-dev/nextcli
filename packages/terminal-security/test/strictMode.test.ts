import { describe, expect, it } from "vitest";

import { evaluateTerminalCommandSecurity } from "../src/index.js";

// strict mode: with a base policy of "allow", only commands the evaluator
// approves on its own run without permission. Commands that normally follow
// the base policy (file and build commands) need permission instead.
describe("evaluateTerminalCommandSecurity strict mode", () => {
  const allow = "allowedWithoutPermission";
  const ask = "allowedWithPermission";

  it.each([
    "ls -la",
    "cat package.json",
    "git status",
    "git diff HEAD~1",
    "git log --oneline",
  ])("still allows the read-only command %s", (command) => {
    expect(
      evaluateTerminalCommandSecurity(allow, command, { strict: true }),
    ).toBe(allow);
  });

  it.each([
    "cp a.txt b.txt",
    "mv a.txt b.txt",
    "tee out.txt",
    "touch x",
    "mkdir out",
    "prettier --write .",
    "tsc --noEmit",
  ])("asks for %s, which follows the base policy otherwise", (command) => {
    expect(evaluateTerminalCommandSecurity(allow, command)).toBe(allow);
    expect(
      evaluateTerminalCommandSecurity(allow, command, { strict: true }),
    ).toBe(ask);
  });

  it("asks when a chained command follows the base policy", () => {
    expect(
      evaluateTerminalCommandSecurity(allow, "ls && cp a b", { strict: true }),
    ).toBe(ask);
  });

  it("keeps catastrophic commands disabled", () => {
    expect(
      evaluateTerminalCommandSecurity(allow, "rm -rf /", { strict: true }),
    ).toBe("disabled");
  });

  it("does not leak into the next, non-strict call", () => {
    evaluateTerminalCommandSecurity(allow, "cp a b", { strict: true });
    expect(evaluateTerminalCommandSecurity(allow, "cp a b")).toBe(allow);
  });
  it.each([
    "echo hi > notes.txt",
    "git log > out.txt",
    "cat a.txt >> b.txt",
    "git diff > patch.diff",
  ])("asks for %s, which writes a file", (command) => {
    expect(evaluateTerminalCommandSecurity(allow, command)).toBe(allow);
    expect(
      evaluateTerminalCommandSecurity(allow, command, { strict: true }),
    ).toBe(ask);
  });

  it.each([
    "npm run build",
    "yarn run build",
    "pnpm run test",
    "make build",
    "cargo build",
    "gradle test",
    "mvn test",
    "tar -cf out.tar .",
    "zip out.zip a.txt",
    "git branch -D feature",
    "git remote add origin https://example.com",
    "git log --output=out.txt",
    "git diff --output=patch.diff",
  ])("asks for %s, which runs code or writes a file", (command) => {
    expect(evaluateTerminalCommandSecurity(allow, command)).toBe(allow);
    expect(
      evaluateTerminalCommandSecurity(allow, command, { strict: true }),
    ).toBe(ask);
  });

  it.each(["ls 2>/dev/null", "git status 2>&1", "cat a.txt < b.txt"])(
    "still allows %s, which writes no file",
    (command) => {
      expect(
        evaluateTerminalCommandSecurity(allow, command, { strict: true }),
      ).toBe(allow);
    },
  );
});
