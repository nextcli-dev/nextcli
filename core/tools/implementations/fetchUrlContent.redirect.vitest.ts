import http from "node:http";
import type { AddressInfo } from "node:net";

import { fetchwithRequestOptions } from "@nextcli/fetch";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ToolExtras } from "../..";
import { fetchUrlContentImpl } from "./fetchUrlContent";

// The extension's fetch, unmocked, against two local servers: A is the site
// the call names, B is another origin that records every request it gets
describe("fetchUrlContentImpl stays on the URL's origin", () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let a: string;
  let b: string;
  let requestsToB: string[];

  const page = (body: string, head = "") =>
    `<html><head><title>Page</title>${head}</head><body><article><p>${body}</p></article></body></html>`;

  const listen = async (server: http.Server) => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    serverB = http.createServer((req, res) => {
      requestsToB.push(req.url ?? "");
      res.end(page("secret page from B"));
    });
    b = await listen(serverB);
    serverA = http.createServer((req, res) => {
      const redirects: Record<string, string> = {
        "/moved": "/docs",
        "/to-b": `${b}/page`,
      };
      const location = redirects[req.url ?? ""];
      if (location) {
        res.writeHead(302, { location });
        res.end();
        return;
      }
      // The origin's page links its icon on B
      res.end(
        req.url === "/"
          ? page("home", `<link rel="icon" href="${b}/favicon.ico">`)
          : page(`docs at ${req.url}`),
      );
    });
    a = await listen(serverA);
  });

  afterAll(async () => {
    await new Promise((resolve) => serverA.close(resolve));
    await new Promise((resolve) => serverB.close(resolve));
  });

  beforeEach(() => {
    requestsToB = [];
  });

  const extras = { fetch: fetchwithRequestOptions } as unknown as ToolExtras;

  it("reads a page and follows a redirect on the same origin", async () => {
    const [item] = await fetchUrlContentImpl({ url: `${a}/moved` }, extras);
    expect(item.content).toContain("docs at /docs");
    expect(requestsToB).toEqual([]);
  });

  it("reports a redirect to another origin instead of reading it", async () => {
    const result = await fetchUrlContentImpl({ url: `${a}/to-b` }, extras);

    expect(result).toHaveLength(1);
    expect(result[0].content).toContain(`${b}/page`);
    expect(result[0].content).not.toContain("secret page from B");
    expect(requestsToB).toEqual([]);
  });

  it("doesn't load a favicon from another origin", async () => {
    const [item] = await fetchUrlContentImpl({ url: `${a}/docs` }, extras);
    expect(item.content).toContain("docs at /docs");
    expect(item.icon).toBeUndefined();
    expect(requestsToB).toEqual([]);
  });

  it("reads the other origin when it is the URL named", async () => {
    const [item] = await fetchUrlContentImpl({ url: `${b}/page` }, extras);
    expect(item.content).toContain("secret page from B");
  });
});
