import { describe, expect, it } from "vitest";

import { isTrustedFetchUrl, normalizeTrustedHost } from "./fetchAccess";

describe("isTrustedFetchUrl", () => {
  const hosts = ["github.com", "*.nextcli.dev"];

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
    expect(isTrustedFetchUrl("https://docs.nextcli.dev/x", hosts)).toBe(true);
    expect(isTrustedFetchUrl("https://nextcli.dev/x", hosts)).toBe(false);
    expect(isTrustedFetchUrl("https://evilnextcli.dev/x", hosts)).toBe(false);
  });

  it.each([
    ["*.0.1", "https://127.0.0.1/"],
    ["*.0.1", "https://10.0.0.1/"],
    ["*.169.254", "https://169.254.169.254/latest/meta-data/"],
    ["*.168.0.1", "https://192.168.0.1/"],
    ["127.1", "https://127.0.0.1/"],
    ["0x7f.0.0.1", "https://127.0.0.1/"],
    ["*.co.uk", "https://bank.co.uk/"],
    ["*.github.io", "https://attacker.github.io/"],
    ["*.githubusercontent.com", "https://raw.githubusercontent.com/x"],
  ])("never trusts %s, so %s still asks", (entry, url) => {
    expect(isTrustedFetchUrl(url, [entry])).toBe(false);
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
    expect(normalizeTrustedHost("*.Docs.NextCLI.dev")).toBe(
      "*.docs.nextcli.dev",
    );
    // A subdomain under a public suffix is a site of its own: list it exactly
    expect(normalizeTrustedHost("raw.githubusercontent.com")).toBe(
      "raw.githubusercontent.com",
    );
    expect(normalizeTrustedHost("*.github.com")).toBe("*.github.com");
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
      // Ends like an IP address, so a wildcard could match private ones
      "*.0.1",
      "*.169.254",
      "*.168.0.1",
      "127.1",
      "0x7f.0.0.1",
      // A wildcard over a public suffix trusts every site under it
      "*.co.uk",
      "*.github.io",
      "*.blogspot.com",
      "*.githubusercontent.com",
      "git hub.com",
      "-github.com",
    ]) {
      expect(normalizeTrustedHost(entry)).toBeUndefined();
    }
  });
});
