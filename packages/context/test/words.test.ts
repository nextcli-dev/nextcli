import { describe, expect, it } from "vitest";

import {
  candidateText,
  findWord,
  indexWords,
  likePatterns,
  searchWord,
} from "../src/historyStore/words.js";

/** Whether a query word matches a text, as the index's LIKE decides it */
function matches(query: string, text: string): boolean {
  const word = searchWord(query)!;
  const words = indexWords(text);
  // A LIKE pattern "% a b %" holds when " a b " is in the words
  return likePatterns(word).some((pattern) =>
    words.includes(pattern.slice(1, -1)),
  );
}

describe("history search words", () => {
  it.each([
    ["config", "loadConfig"],
    ["config", "getLoadConfig"],
    ["loadConfig", "getLoadConfig"],
    ["byId", "getElementById"],
    ["elementById", "getElementById"],
    ["id", "userId"],
    ["id", "userID"],
    ["encode", "base64Encode"],
    ["base64", "base64Encode"],
    ["http", "XMLHttpRequest"],
    ["config", "HTTPConfig"],
    ["xml", "loadXMLParser"],
    ["timeout", "login_timeout_ms"],
    ["auth", "src/auth/token.ts"],
    ["src/auth", "src/auth/token.ts"],
    ["getelementbyid", "getElementById"],
    ["Über", "über das Problem"],
  ])("finds %s in %s", (query, text) => {
    expect(matches(query, text)).toBe(true);
  });

  it.each([
    ["fix", "Fixed the bug"],
    ["fix", "fixes"],
    ["fix", "fixing"],
    ["fixed", "fix it"],
    ["use", "used"],
    ["use", "using"],
    ["used", "use"],
    ["stop", "stopped"],
    ["stopping", "stop"],
    ["timeouts", "a timeout"],
    ["match", "matches"],
  ])("finds %s in its other form %s", (query, text) => {
    expect(matches(query, text)).toBe(true);
  });

  it.each([
    ["fix", "prefix"],
    ["not", "nothing"],
    ["not", "note"],
    ["not", "another"],
    ["log", "login"],
    ["42", "1420"],
    ["id", "idle"],
    ["loadConfig", "load the config"],
  ])("doesn't find %s in %s", (query, text) => {
    expect(matches(query, text)).toBe(false);
  });

  it("gives FTS5 the text every match contains", () => {
    expect(candidateText(searchWord("fixing")!)).toEqual(["fix"]);
    expect(candidateText(searchWord("loadConfig")!)).toEqual([
      "load",
      "config",
    ]);
    // used, use, uses, using share only "us": too short for trigrams
    expect(candidateText(searchWord("use")!)).toEqual([]);
  });

  it("finds where a word matches, past one it only looks like", () => {
    const text = "the prefix of the fix";
    const at = findWord(text, [searchWord("fix")!]);

    expect(at && text.slice(at.start, at.end)).toBe("fix");
    expect(at?.start).toBe(text.lastIndexOf("fix"));
  });
});
