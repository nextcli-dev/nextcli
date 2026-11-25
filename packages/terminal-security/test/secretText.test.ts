import { describe, expect, it } from "vitest";

import { redactSecretText } from "../src/index.js";

describe("redactSecretText", () => {
  it.each([
    ["an OpenAI key", "use sk-proj-abcdefghijklmnop1234 here"],
    ["a GitHub token", "token ghp_abcdefghijklmnopqrstuvwxyz0123"],
    ["a fine-grained GitHub token", "github_pat_11ABCDEFG0123456789abcdef"],
    ["a GitLab token", "glpat-abcdefghijklmnopqrst"],
    ["a Slack token", "xoxb-1234567890-abcdef"],
    ["an AWS key id", "id AKIAIOSFODNN7EXAMPLE ok"],
    ["a Google key", "AIzaSyA1234567890abcdefghijklmnopqrstuv"],
    ["a Hugging Face token", "hf_abcdefghijklmnopqrstuvwx"],
    ["an npm token", "npm_abcdefghijklmnopqrstuvwx"],
    [
      "a JWT",
      "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    ],
  ])("removes %s", (_, text) => {
    const redacted = redactSecretText(text);

    expect(redacted).toContain("[redacted]");
    expect(redacted.length).toBeLessThan(text.length);
  });

  it("removes a private key block whole", () => {
    const text =
      "before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----\nafter";

    expect(redactSecretText(text)).toBe("before\n[redacted]\nafter");
  });

  it("removes the password of a URL and keeps the rest", () => {
    expect(
      redactSecretText("clone https://bob:hunter2pass@git.example.com/r.git"),
    ).toBe("clone https://bob:[redacted]@git.example.com/r.git");
  });

  it("removes the value of a secret-named assignment, in any notation", () => {
    expect(
      redactSecretText(
        'DB_PASSWORD=correcthorse and "apiKey": "abcdef123456" and token: zyx98765',
      ),
    ).toBe(
      'DB_PASSWORD=[redacted] and "apiKey": "[redacted]" and token: [redacted]',
    );
  });

  it("keeps ordinary words and settings that look close", () => {
    const text = [
      "the desk-lamp and task-runner-1234567890abcdef tests",
      "ghost_writer, PATH=/usr/local/bin, NODE_ENV=production",
      "TOKENIZERS_PARALLELISM=true, https://github.com/nextcli-dev/nextcli",
      "a short key: abc",
    ].join("\n");

    expect(redactSecretText(text)).toBe(text);
  });
});
