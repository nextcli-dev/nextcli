import http from "node:http";
import type { AddressInfo } from "node:net";

import { Agent } from "undici";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  checkAddress,
  createGuardedConnector,
  createGuardedFetch,
  createGuardedLookup,
  FetchRefusedError,
} from "./fetchGuard.js";

describe("checkAddress", () => {
  it.each([
    // Public addresses pass
    ["93.184.215.14", null],
    ["1.1.1.1", null],
    ["2606:4700:4700::1111", null],
    ["2002:5db8:d70e::1", null], // 6to4 of 93.184.215.14
    // Loopback, private, shared and reserved
    ["127.0.0.1", "private"],
    ["10.1.2.3", "private"],
    ["172.16.0.1", "private"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["0.0.0.0", "private"],
    ["224.0.0.1", "private"],
    ["::1", "private"],
    ["::", "private"],
    ["fd12:3456::1", "private"],
    ["fe80::1", "private"],
    ["::ffff:127.0.0.1", "private"], // IPv4-mapped
    ["::ffff:7f00:1", "private"],
    ["64:ff9b::a00:1", "private"], // NAT64 of 10.0.0.1
    ["2002:c0a8:101::1", "private"], // 6to4 of 192.168.1.1
    // Cloud metadata
    ["169.254.169.254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["fd00:ec2::254", "metadata"],
    ["::ffff:169.254.169.254", "metadata"],
    ["64:ff9b::a9fe:a9fe", "metadata"],
  ])("%s is %s", (address, expected) => {
    expect(checkAddress(address)).toBe(expected);
  });

  it("allowPrivate lifts private ranges but never metadata", () => {
    expect(checkAddress("127.0.0.1", { allowPrivate: true })).toBeNull();
    expect(checkAddress("10.0.0.1", { allowPrivate: true })).toBeNull();
    expect(checkAddress("::1", { allowPrivate: true })).toBeNull();
    expect(checkAddress("169.254.169.254", { allowPrivate: true })).toBe(
      "metadata",
    );
    expect(checkAddress("fd00:ec2::254", { allowPrivate: true })).toBe(
      "metadata",
    );
  });
});

describe("createGuardedLookup", () => {
  const resolverFor =
    (addresses: { address: string; family: number }[]) =>
    (_host: string, _options: unknown, callback: any) =>
      callback(null, addresses);

  const lookup = (
    fn: ReturnType<typeof createGuardedLookup>,
    options: object,
  ): Promise<unknown[]> =>
    new Promise((resolve, reject) =>
      (fn as any)(
        "example.test",
        options,
        (err: Error | null, ...rest: unknown[]) =>
          err ? reject(err) : resolve(rest),
      ),
    );

  it("returns a public host's addresses, one or all", async () => {
    const fn = createGuardedLookup(
      false,
      resolverFor([
        { address: "93.184.215.14", family: 4 },
        { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
      ]),
    );
    expect(await lookup(fn, {})).toEqual(["93.184.215.14", 4]);
    expect(await lookup(fn, { all: true })).toEqual([
      [
        { address: "93.184.215.14", family: 4 },
        { address: "2606:2800:21f:cb07:6820:80da:af6b:8b2c", family: 6 },
      ],
    ]);
  });

  it("refuses a host when any of its addresses is private", async () => {
    const fn = createGuardedLookup(
      false,
      resolverFor([
        { address: "93.184.215.14", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ]),
    );
    await expect(lookup(fn, { all: true })).rejects.toThrow(FetchRefusedError);
  });
});

describe("createGuardedFetch against local servers", () => {
  // Server A redirects to server B (another origin) or to metadata; B
  // records the requests it receives
  let serverA: http.Server;
  let serverB: http.Server;
  let a: string;
  let b: string;
  let requestsToB: http.IncomingHttpHeaders[];

  const listen = async (server: http.Server) => {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeAll(async () => {
    serverB = http.createServer((req, res) => {
      requestsToB.push(req.headers);
      res.end("docs from B");
    });
    b = await listen(serverB);
    serverA = http.createServer((req, res) => {
      // /hops/N redirects N times before answering
      const hops = req.url?.match(/^\/hops\/(\d+)$/);
      if (hops && Number(hops[1]) > 0) {
        res.writeHead(302, { location: `/hops/${Number(hops[1]) - 1}` });
        res.end();
        return;
      }
      const location =
        req.url === "/to-b"
          ? `${b}/page`
          : req.url === "/to-metadata"
            ? "http://169.254.169.254/latest/meta-data/"
            : req.url === "/to-file"
              ? "file:///etc/passwd"
              : undefined;
      if (location) {
        res.writeHead(302, { location });
        res.end();
        return;
      }
      res.end("docs from A");
    });
    a = await listen(serverA);
  });

  afterAll(async () => {
    await new Promise((resolve) => serverA.close(resolve));
    await new Promise((resolve) => serverB.close(resolve));
  });

  it.each([
    (port: string) => `http://127.0.0.1:${port}/`,
    (port: string) => `http://0x7f000001:${port}/`,
    (port: string) => `http://[::1]:${port}/`,
    () => "http://169.254.169.254/latest/meta-data/",
  ])("refuses an IP-literal host before connecting (%#)", async (url) => {
    requestsToB = [];
    const port = new URL(b).port;
    await expect(createGuardedFetch()(url(port))).rejects.toThrow(
      FetchRefusedError,
    );
    expect(requestsToB).toHaveLength(0);
  });

  it("serves a private address with allowPrivate", async () => {
    const response = await createGuardedFetch({ allowPrivate: true })(`${a}/`);
    expect(await response.text()).toBe("docs from A");
  });

  it("follows a redirect to another origin and drops its credentials", async () => {
    requestsToB = [];
    const response = await createGuardedFetch({ allowPrivate: true })(
      `${a}/to-b`,
      { headers: { authorization: "Bearer secret" } },
    );

    expect(await response.text()).toBe("docs from B");
    expect(requestsToB).toHaveLength(1);
    expect(requestsToB[0].authorization).toBeUndefined();
  });

  it("refuses a redirect to metadata even with allowPrivate", async () => {
    await expect(
      createGuardedFetch({ allowPrivate: true })(`${a}/to-metadata`),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    await expect(
      createGuardedFetch({ allowPrivate: true })(`${a}/to-file`),
    ).rejects.toThrow();
  });

  // A hostname is checked when the socket connects, so a name that resolves
  // to a private address is refused whatever it looked like before
  it("checks a hostname's address at connect time", async () => {
    const toLoopback = (_host: string, _options: unknown, callback: any) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]);
    const url = `http://rebind.example:${new URL(a).port}/`;

    await expect(
      createGuardedFetch({
        dispatcher: new Agent({
          connect: createGuardedConnector(false, toLoopback),
        }),
      })(url),
    ).rejects.toThrow(FetchRefusedError);

    const response = await createGuardedFetch({
      dispatcher: new Agent({
        connect: createGuardedConnector(true, toLoopback),
      }),
    })(url);
    expect(await response.text()).toBe("docs from A");
  });

  // The Fetch standard's limit, which undici enforces
  it("follows 20 redirects and refuses the 21st", async () => {
    const guarded = createGuardedFetch({ allowPrivate: true });
    expect(await (await guarded(`${a}/hops/20`)).text()).toBe("docs from A");
    await expect(guarded(`${a}/hops/21`)).rejects.toThrow();
  });
});

describe("createGuardedFetch error reporting", () => {
  const refusal = new FetchRefusedError("10.0.0.1", "10.0.0.1", "private");
  const failingWith = (error: Error) =>
    createGuardedFetch({
      dispatcher: new Agent({
        connect: (_options, callback) => callback(error, null),
      }),
    });

  it.each([
    [
      "wrapped in another error",
      new Error("connect failed", { cause: refusal }),
    ],
    [
      "inside an AggregateError",
      new AggregateError([new Error("other"), refusal]),
    ],
  ])("reports a refusal %s", async (_label, error) => {
    await expect(failingWith(error)("http://example.test/")).rejects.toBe(
      refusal,
    );
  });

  it("passes other failures through", async () => {
    await expect(
      failingWith(new Error("ECONNRESET"))("http://example.test/"),
    ).rejects.toThrow(/fetch failed/);
  });
});
