import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  assertFetchableUrl,
  checkAddress,
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

describe("assertFetchableUrl", () => {
  it("lets public http and https URLs through", () => {
    expect(() =>
      assertFetchableUrl(new URL("https://example.com/docs"), false),
    ).not.toThrow();
    expect(() =>
      assertFetchableUrl(new URL("http://93.184.215.14/"), false),
    ).not.toThrow();
  });

  it.each([
    "http://127.0.0.1:8080/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://127.1/",
    "http://[::1]/",
    "http://[::ffff:169.254.169.254]/",
    "http://169.254.169.254/latest/meta-data/",
    "http://localhost:3000/",
    "http://api.localhost/",
    "http://LOCALHOST./",
  ])("refuses %s", (url) => {
    expect(() => assertFetchableUrl(new URL(url), false)).toThrow(
      FetchRefusedError,
    );
  });

  it.each(["file:///etc/passwd", "ftp://example.com/", "data:text/plain,hi"])(
    "refuses the scheme of %s",
    (url) => {
      expect(() => assertFetchableUrl(new URL(url), true)).toThrow(
        /only http and https/,
      );
    },
  );

  it("names the flag only when it would help", () => {
    expect(() =>
      assertFetchableUrl(new URL("http://127.0.0.1/"), false),
    ).toThrow(/--allow-private-fetch/);
    expect(() =>
      assertFetchableUrl(new URL("http://169.254.169.254/"), true),
    ).toThrow(/^Fetch refused: 169\.254\.169\.254 resolves to .*\)\.$/);
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

describe("createGuardedFetch redirects", () => {
  const redirect = (location: string, status = 302) =>
    new Response(null, { status, headers: { location } });

  it("follows public redirects and checks every hop", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(redirect("/moved"))
      .mockResolvedValueOnce(redirect("https://docs.example.org/page", 301))
      .mockResolvedValueOnce(new Response("final"));
    const guarded = createGuardedFetch({ fetchImpl });

    const response = await guarded("https://example.com/start");

    expect(await response.text()).toBe("final");
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://example.com/start",
      "https://example.com/moved",
      "https://docs.example.org/page",
    ]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.redirect).toBe("manual");
    }
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://127.0.0.1:9000/admin",
    "file:///etc/passwd",
  ])("refuses a redirect to %s before connecting", async (location) => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(redirect(location));
    const guarded = createGuardedFetch({ fetchImpl });

    await expect(guarded("https://example.com/")).rejects.toThrow(
      /Fetch refused/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stops after five redirects", async () => {
    const fetchImpl = vi.fn(async () => redirect("https://example.com/loop"));
    const guarded = createGuardedFetch({ fetchImpl });

    await expect(guarded("https://example.com/")).rejects.toThrow(
      /more than 5 redirects/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});

describe("createGuardedFetch against a local server", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/" });
        res.end();
        return;
      }
      res.end("local docs");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("refuses loopback by default", async () => {
    await expect(
      createGuardedFetch()(`http://127.0.0.1:${port}/`),
    ).rejects.toThrow(FetchRefusedError);
  });

  it("serves loopback with allowPrivate", async () => {
    const response = await createGuardedFetch({ allowPrivate: true })(
      `http://127.0.0.1:${port}/`,
    );
    expect(await response.text()).toBe("local docs");
  });

  it("keeps metadata blocked when a private server redirects there", async () => {
    await expect(
      createGuardedFetch({ allowPrivate: true })(
        `http://127.0.0.1:${port}/to-metadata`,
      ),
    ).rejects.toThrow(/169\.254\.169\.254/);
  });

  // A hostname is checked when the socket connects, so a name that resolves
  // to a private address is refused whatever it looked like before.
  it("checks a hostname's address at connect time", async () => {
    const toLoopback = (_host: string, _options: unknown, callback: any) =>
      callback(null, [{ address: "127.0.0.1", family: 4 }]);

    await expect(
      createGuardedFetch({ resolve: toLoopback })(
        `http://rebind.example:${port}/`,
      ),
    ).rejects.toThrow(FetchRefusedError);

    const response = await createGuardedFetch({
      allowPrivate: true,
      resolve: toLoopback,
    })(`http://rebind.example:${port}/`);
    expect(await response.text()).toBe("local docs");
  });
});
