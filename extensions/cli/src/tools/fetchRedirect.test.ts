import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fetchTool } from "./fetch.js";
import { setRunSafetyOptions } from "./runSafetyOptions.js";

// The Fetch tool, guard and core implementation unmocked, against two local
// servers (so --allow-private-fetch): A is the URL the call names, B is
// another origin that records every request it gets
describe("Fetch stays on the URL's origin", () => {
  let serverA: http.Server;
  let serverB: http.Server;
  let a: string;
  let b: string;
  let requestsToB: string[];

  const page = (body: string) =>
    `<html><head><title>Page</title></head><body><article><p>${body}</p></article></body></html>`;

  const listen = async (server: http.Server) => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    serverB = http.createServer((req, res) => {
      requestsToB.push(req.url ?? "");
      res.end(page("page from B"));
    });
    b = await listen(serverB);
    serverA = http.createServer((req, res) => {
      const location =
        req.url === "/moved"
          ? "/docs"
          : req.url === "/to-b"
            ? `${b}/page`
            : undefined;
      if (location) {
        res.writeHead(302, { location });
        res.end();
        return;
      }
      res.end(page(`docs at ${req.url}`));
    });
    a = await listen(serverA);
  });

  afterAll(async () => {
    setRunSafetyOptions({});
    await new Promise((resolve) => serverA.close(resolve));
    await new Promise((resolve) => serverB.close(resolve));
  });

  beforeEach(() => {
    requestsToB = [];
    setRunSafetyOptions({ allowPrivateFetch: true });
  });

  const run = (url: string) =>
    fetchTool.run(
      { url },
      { toolCallId: "call_1", parallelToolCallCount: 1 },
    ) as Promise<string>;

  it("follows a redirect on the same origin", async () => {
    expect(await run(`${a}/moved`)).toContain("docs at /docs");
  });

  it("reports a redirect to another origin, so its URL is checked on its own", async () => {
    const output = await run(`${a}/to-b`);

    expect(output).toContain(`${b}/page`);
    expect(output).not.toContain("page from B");
    expect(requestsToB).toEqual([]);
  });
});
