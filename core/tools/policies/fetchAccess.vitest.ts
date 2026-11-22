import { describe, expect, it } from "vitest";

import { isTrustedFetchUrl, normalizeTrustedHost } from "./fetchAccess";

describe("isTrustedFetchUrl", () => {
  const hosts = ["github.com", "*.githubusercontent.com"];

  it("trusts https URLs on a listed host", () => {
    expect(
      isTrustedFetchUrl(
        "https://github.com/nextcli-dev/nextcli/pull/203",
        hosts,
      ),
    ).toBe(true);
    expect(isTrustedFetchUrl("https://GitHub.com/a?b=c#d", hosts)).toBe(true);
    expect(isTrustedFetchUrl("https://github.com./a", hosts)).toBe(true);
    expect(isTrustedFetchUrl("https://github.com:443/a", hosts)).toBe(true);
  });

  it("matches an exact entry only, not its subdomains or lookalikes", () => {
    expect(isTrustedFetchUrl("https://api.github.com/x", hosts)).toBe(false);
    expect(isTrustedFetchUrl("https://github.com.evil.example/", hosts)).toBe(
      false,
    );
    expect(isTrustedFetchUrl("https://evilgithub.com/", hosts)).toBe(false);
  });

  it("matches a wildcard entry's subdomains, not the bare domain", () => {
    expect(
      isTrustedFetchUrl("https://raw.githubusercontent.com/o/r/main/x", hosts),
    ).toBe(true);
    expect(isTrustedFetchUrl("https://githubusercontent.com/x", hosts)).toBe(
      false,
    );
    expect(
      isTrustedFetchUrl("https://evilgithubusercontent.com/x", hosts),
    ).toBe(false);
  });

  it("asks for anything but plain https on the default port", () => {
    expect(isTrustedFetchUrl("http://github.com/a", hosts)).toBe(false);
    expect(isTrustedFetchUrl("https://github.com:8443/a", hosts)).toBe(false);
    expect(isTrustedFetchUrl("https://github.com@evil.example/a", hosts)).toBe(
      false,
    );
    expect(isTrustedFetchUrl("https://user:pw@github.com/a", hosts)).toBe(
      false,
    );
    expect(isTrustedFetchUrl("file:///etc/passwd", hosts)).toBe(false);
    expect(isTrustedFetchUrl("not a url", hosts)).toBe(false);
    expect(isTrustedFetchUrl("", hosts)).toBe(false);
  });

  it("trusts nothing with an empty list", () => {
    expect(isTrustedFetchUrl("https://github.com/", [])).toBe(false);
  });
});

describe("normalizeTrustedHost", () => {
  it("keeps the host of what was pasted", () => {
    expect(normalizeTrustedHost(" GitHub.com ")).toBe("github.com");
    expect(normalizeTrustedHost("https://github.com/nextcli-dev")).toBe(
      "github.com",
    );
    expect(normalizeTrustedHost("github.com/")).toBe("github.com");
    expect(normalizeTrustedHost("*.GitHubUserContent.com")).toBe(
      "*.githubusercontent.com",
    );
  });

  it("refuses what isn't a host name", () => {
    for (const entry of [
      "",
      "localhost",
      "*.com",
      "*",
      "github.com:8443",
      "10.0.0.1",
      "*.10.0.0.1",
      "git hub.com",
      "-github.com",
    ]) {
      expect(normalizeTrustedHost(entry)).toBeUndefined();
    }
  });
});
