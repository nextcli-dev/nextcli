import dns from "node:dns";
import net from "node:net";

import { Agent, buildConnector, fetch as undiciFetch } from "undici";

/**
 * Keeps the Fetch tool on the public internet. A prompt injection must not be
 * able to make it read a cloud-metadata endpoint (instance credentials) or a
 * service on the runner's private network. Every connection is checked when
 * it opens: the first request, each redirect undici follows, and the favicon
 * requests. A DNS answer that changes after an earlier check (rebinding) is
 * caught too.
 */

export type BlockedKind = "metadata" | "private";

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
 * A connector for undici that refuses blocked addresses. An IP-literal host
 * is checked here, because net.connect skips `lookup` for it; a name goes
 * through the guarded lookup.
 */
export function createGuardedConnector(
  allowPrivate: boolean,
  resolve?: Resolver,
): buildConnector.connector {
  const connect = buildConnector({
    lookup: createGuardedLookup(allowPrivate, resolve),
  });
  return (options, callback) => {
    if (net.isIP(options.hostname)) {
      const kind = checkAddress(options.hostname, { allowPrivate });
      if (kind) {
        callback(
          new FetchRefusedError(options.hostname, options.hostname, kind),
          null,
        );
        return;
      }
    }
    connect(options, callback);
  };
}

// One connection pool per setting, shared by every Fetch call in the run
const dispatchers = new Map<boolean, Agent>();
function sharedDispatcher(allowPrivate: boolean): Agent {
  let agent = dispatchers.get(allowPrivate);
  if (!agent) {
    agent = new Agent({ connect: createGuardedConnector(allowPrivate) });
    dispatchers.set(allowPrivate, agent);
  }
  return agent;
}

export interface GuardedFetchOptions {
  allowPrivate?: boolean;
  signal?: AbortSignal;
  /** Replaces the shared pool, so tests can use a fake resolver */
  dispatcher?: Agent;
}

/**
 * A fetch function for the Fetch tool. undici follows redirects (at most 20,
 * http and https only, credentials dropped on a cross-origin hop) through the
 * same guarded connector, so every hop reaches only public addresses, or
 * private ones with allowPrivate; never cloud metadata.
 */
export function createGuardedFetch({
  allowPrivate = false,
  signal,
  dispatcher,
}: GuardedFetchOptions = {}): (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response> {
  return async (input, init = {}) => {
    try {
      return (await undiciFetch(input, {
        ...(init as Record<string, unknown>),
        dispatcher: dispatcher ?? sharedDispatcher(allowPrivate),
        ...(signal ? { signal } : {}),
      })) as unknown as Response;
    } catch (error) {
      // undici reports a refused connect as "fetch failed" with the refusal
      // somewhere in its causes; the model needs the refusal's message
      throw findRefusal(error) ?? error;
    }
  };
}

/** The FetchRefusedError in an error's cause chain or AggregateError list */
function findRefusal(error: unknown, depth = 0): FetchRefusedError | undefined {
  if (error instanceof FetchRefusedError) return error;
  if (!error || typeof error !== "object" || depth > 10) return undefined;
  const { cause, errors } = error as { cause?: unknown; errors?: unknown };
  for (const inner of [cause, ...(Array.isArray(errors) ? errors : [])]) {
    const found = findRefusal(inner, depth + 1);
    if (found) return found;
  }
  return undefined;
}
