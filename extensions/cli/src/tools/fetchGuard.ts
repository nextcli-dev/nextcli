import dns from "node:dns";
import net from "node:net";

import { Agent, fetch as undiciFetch } from "undici";

/**
 * Keeps the Fetch tool on the public internet. A prompt injection must not be
 * able to make it read a cloud-metadata endpoint (instance credentials) or a
 * service on the runner's private network. The address is checked when the
 * socket connects, so a DNS answer that changes after a first check
 * (rebinding) is caught too, and every redirect hop is checked again.
 */

export type BlockedKind = "metadata" | "private";

const MAX_REDIRECTS = 5;

// Blocked even with --allow-private-fetch: these serve instance credentials
const metadata = new net.BlockList();
metadata.addSubnet("169.254.0.0", 16, "ipv4"); // AWS, GCP, Azure; link-local
metadata.addAddress("100.100.100.200", "ipv4"); // Alibaba Cloud
metadata.addAddress("fd00:ec2::254", "ipv6"); // AWS over IPv6

// Loopback, private, shared and reserved ranges: --allow-private-fetch lifts these
const privateRanges = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  privateRanges.addSubnet(address, prefix, "ipv4");
}
privateRanges.addAddress("::", "ipv6");
privateRanges.addAddress("::1", "ipv6");
privateRanges.addSubnet("fc00::", 7, "ipv6");
privateRanges.addSubnet("fe80::", 10, "ipv6");
privateRanges.addSubnet("ff00::", 8, "ipv6");

/** Expands an IPv6 address into its eight 16-bit groups */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split("%")[0];
  // A trailing dotted IPv4 part (::ffff:1.2.3.4) becomes two groups
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const bytes = dotted[1].split(".").map(Number);
    text =
      text.slice(0, -dotted[1].length) +
      `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const [head, tail] = text.split("::");
  const parse = (part: string | undefined) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const start = parse(head);
  const end = parse(tail);
  const groups =
    tail === undefined
      ? start
      : [...start, ...Array(8 - start.length - end.length).fill(0), ...end];
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff)
    ? groups
    : undefined;
}

/**
 * The IPv4 address an IPv6 address carries, for the forms that reach an IPv4
 * host: NAT64 (64:ff9b::/96) and 6to4 (2002::/16). IPv4-mapped addresses
 * (::ffff:0:0/96) are matched by BlockList itself.
 */
function embeddedIpv4(address: string): string | undefined {
  const g = ipv6Groups(address);
  if (!g) return undefined;
  const toIpv4 = (high: number, low: number) =>
    [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return toIpv4(g[6], g[7]);
  }
  if (g[0] === 0x2002) {
    return toIpv4(g[1], g[2]);
  }
  return undefined;
}

/**
 * Whether Fetch may connect to an IP address: "metadata" is always refused,
 * "private" is refused unless the run allows private addresses, null is fine.
 */
export function checkAddress(
  address: string,
  { allowPrivate = false }: { allowPrivate?: boolean } = {},
): BlockedKind | null {
  const family = net.isIP(address);
  if (family === 0) return "private"; // not an address: refuse rather than guess
  const type = family === 4 ? "ipv4" : "ipv6";
  const ipv4 = family === 6 ? embeddedIpv4(address) : undefined;

  if (metadata.check(address, type) || (ipv4 && metadata.check(ipv4, "ipv4"))) {
    return "metadata";
  }
  if (
    !allowPrivate &&
    (privateRanges.check(address, type) ||
      (ipv4 !== undefined && privateRanges.check(ipv4, "ipv4")))
  ) {
    return "private";
  }
  return null;
}

/** A request Fetch refuses to make; the message goes back to the model */
export class FetchRefusedError extends Error {
  constructor(host: string, address: string, kind: BlockedKind) {
    super(
      `Fetch refused: ${host} resolves to a private or cloud-metadata address (${address}).` +
        (kind === "private"
          ? " Private addresses need --allow-private-fetch."
          : ""),
    );
    this.name = "FetchRefusedError";
  }
}

type LookupAddress = { address: string; family: number };
type Resolver = (
  hostname: string,
  options: dns.LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: LookupAddress[],
  ) => void,
) => void;

/**
 * A `lookup` for net.connect that refuses a host if any of its addresses is
 * blocked. Answers both `all: true` callers (Happy Eyeballs) and single ones.
 */
export function createGuardedLookup(
  allowPrivate: boolean,
  resolve: Resolver = dns.lookup as unknown as Resolver,
): net.LookupFunction {
  return ((hostname: string, options: any, callback: any) => {
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if (typeof options === "number") {
      options = { family: options };
    }
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      for (const { address } of addresses) {
        const kind = checkAddress(address, { allowPrivate });
        if (kind) {
          return callback(new FetchRefusedError(hostname, address, kind));
        }
      }
      if (options.all) return callback(null, addresses);
      if (addresses.length === 0) {
        return callback(
          Object.assign(new Error(`No address found for ${hostname}`), {
            code: "ENOTFOUND",
          }),
        );
      }
      callback(null, addresses[0].address, addresses[0].family);
    });
  }) as net.LookupFunction;
}

/**
 * Refuses a URL before any connection: anything but http(s), localhost names,
 * and IP-literal hosts (net.connect skips `lookup` for those).
 */
export function assertFetchableUrl(url: URL, allowPrivate: boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Fetch refused: only http and https URLs are allowed, not ${url.protocol}`,
    );
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (net.isIP(host)) {
    const kind = checkAddress(host, { allowPrivate });
    if (kind) throw new FetchRefusedError(url.hostname, host, kind);
    return;
  }
  const lower = host.toLowerCase();
  if (
    !allowPrivate &&
    (lower === "localhost" || lower.endsWith(".localhost"))
  ) {
    throw new FetchRefusedError(url.hostname, "127.0.0.1", "private");
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// One connection pool per setting, shared by every Fetch call in the run
const dispatchers = new Map<boolean, Agent>();
function sharedDispatcher(allowPrivate: boolean): Agent {
  let agent = dispatchers.get(allowPrivate);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: createGuardedLookup(allowPrivate) },
    });
    dispatchers.set(allowPrivate, agent);
  }
  return agent;
}

type FetchImpl = (
  url: string,
  init: Record<string, unknown>,
) => Promise<Response>;

export interface GuardedFetchOptions {
  allowPrivate?: boolean;
  signal?: AbortSignal;
  /** For tests: the fetch that makes each single request */
  fetchImpl?: FetchImpl;
  /** For tests: the resolver behind the connect-time check */
  resolve?: Resolver;
}

/**
 * A fetch function for the Fetch tool. Each request, redirects included,
 * reaches only public addresses (or private ones with allowPrivate; never
 * cloud metadata).
 */
export function createGuardedFetch({
  allowPrivate = false,
  signal,
  fetchImpl,
  resolve,
}: GuardedFetchOptions = {}): (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  const dispatcher = resolve
    ? new Agent({
        connect: { lookup: createGuardedLookup(allowPrivate, resolve) },
      })
    : sharedDispatcher(allowPrivate);
  const send: FetchImpl =
    fetchImpl ??
    ((url, init) => undiciFetch(url, init) as unknown as Promise<Response>);

  return async (input, init = {}) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      assertFetchableUrl(url, allowPrivate);
      let response: Response;
      try {
        response = await send(url.toString(), {
          ...init,
          method,
          body,
          redirect: "manual",
          dispatcher,
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        // undici reports a refused connect as "fetch failed" with the cause
        const cause = (error as { cause?: unknown })?.cause;
        throw cause instanceof FetchRefusedError ? cause : error;
      }

      const location = response.headers.get("location");
      if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return response;
      }
      await response.body?.cancel();
      url = new URL(location, url);
      // 307 and 308 keep the method and body; the others become a GET
      if (response.status !== 307 && response.status !== 308) {
        method = "GET";
        body = undefined;
      }
    }
    throw new Error(`Fetch refused: more than ${MAX_REDIRECTS} redirects`);
  };
}
