import { describe, expect, it, vi } from "vitest";

import { JiraClient } from "./JiraClient";

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text, marks: [{ type: "strong" }] },
        { type: "text", text: " for " },
        { type: "mention", attrs: { id: "1", text: "@Ann Lee" } },
      ],
    },
  ],
});

const author = { emailAddress: "a@x.dev", displayName: "A" };

function fetchReturning(issue: unknown) {
  return vi.fn(async () => ({ json: async () => issue }));
}

describe("JiraClient.issue", () => {
  const client = new JiraClient({
    domain: "acme.atlassian.net",
    username: "me@acme.dev",
    password: "token",
  });

  it("converts ADF descriptions and comments (API v3) to Markdown", async () => {
    const customFetch = fetchReturning({
      key: "NX-1",
      fields: {
        summary: "Crash on start",
        description: adf("Description"),
        comment: {
          comments: [
            { body: adf("Comment"), author, created: "c", updated: "u" },
          ],
        },
      },
    });

    const issue = await client.issue("NX-1", customFetch);

    expect(customFetch).toHaveBeenCalledWith(
      new URL(
        "https://acme.atlassian.net/rest/api/3/issue/NX-1?fields=description,comment,summary",
      ),
      expect.anything(),
    );
    expect(issue.key).toBe("NX-1");
    expect(issue.summary).toBe("Crash on start");
    expect(issue.description).toBe("**Description** for @Ann Lee");
    expect(issue.comments).toEqual([
      {
        body: "**Comment** for @Ann Lee",
        author,
        created: "c",
        updated: "u",
      },
    ]);
  });

  it("does not fail the issue over a malformed node in one comment", async () => {
    const badComment = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "still here", marks: [null] }],
        },
      ],
    };
    const issue = await client.issue(
      "NX-4",
      fetchReturning({
        key: "NX-4",
        fields: {
          summary: "s",
          description: adf("Description"),
          comment: {
            comments: [
              { body: badComment, author, created: "c", updated: "u" },
              { body: adf("Good"), author, created: "c", updated: "u" },
            ],
          },
        },
      }),
    );
    expect(issue.description).toBe("**Description** for @Ann Lee");
    expect(issue.comments.map((c) => c.body)).toEqual([
      "still here",
      "**Good** for @Ann Lee",
    ]);
  });

  it("keeps plain-text descriptions and comments (API v2) as they are", async () => {
    const issue = await client.issue(
      "NX-2",
      fetchReturning({
        key: "NX-2",
        fields: {
          summary: "s",
          description: "*wiki* text",
          comment: {
            comments: [{ body: "plain", author, created: "c", updated: "u" }],
          },
        },
      }),
    );
    expect(issue.description).toBe("*wiki* text");
    expect(issue.comments[0].body).toBe("plain");
  });

  it("handles an issue with no description or comments", async () => {
    const issue = await client.issue(
      "NX-3",
      fetchReturning({ key: "NX-3", fields: { summary: "s" } }),
    );
    expect(issue.description).toBe("");
    expect(issue.comments).toEqual([]);
  });
});
