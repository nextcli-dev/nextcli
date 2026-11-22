import { getPublicSuffix } from "tldts";

/**
 * Hosts the user trusts for the Read URL tool (fetch_url_content): a fetch
 * of an https URL on one of them runs without asking. A URL can carry data
 * out, so the list starts empty and only the user adds to it.
 */

// A host name with at least two labels, optionally behind "*." for its
// subdomains. Bare names (localhost) don't qualify.
const HOST_PATTERN =
  /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// A top-level domain starts with a letter. Anything else ends like an IP
// address (10.0.0.1, 127.1, 0x7f.0.0.1), which new URL turns into one.
const TLD_PATTERN = /\.[a-z][a-z0-9-]*$/;

/**
 * The form a trusted-host entry is stored in, or undefined when the text
 * isn't a host name: "GitHub.com", "https://github.com/org" and
 * "github.com/" all give "github.com"; "*.github.com" stays a wildcard.
 * Refused: a port (a fetch is trusted only on the default https port), an
 * entry that ends like an IP address, whose wildcard could match private
 * ones (*.0.1, *.169.254), and a wildcard over a public suffix from the
 * Public Suffix List, private section included (*.co.uk, *.github.io,
 * *.githubusercontent.com), which would trust every site under it.
 */
export function normalizeTrustedHost(entry: string): string | undefined {
  let host = entry.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/[/?#].*$/, "");
  host = host.replace(/\.$/, "");
  if (!HOST_PATTERN.test(host) || !TLD_PATTERN.test(host)) {
    return undefined;
  }
  if (host.startsWith("*.")) {
    const base = host.slice(2);
    if (getPublicSuffix(base, { allowPrivateDomains: true }) === base) {
      return undefined;
    }
  }
  return host;
}

/**
 * Whether a fetch of this URL may run without asking: an https URL on the
 * default port, with no user name or password, whose host is a trusted
 * entry ("github.com" matches only that host, "*.github.com" only its
 * subdomains).
 */
export function isTrustedFetchUrl(
  url: string,
  trustedHosts: readonly string[],
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return false;
  }
  const hostname = parsed.hostname.replace(/\.$/, "");
  return trustedHosts.some((entry) => {
    const trusted = normalizeTrustedHost(entry);
    if (!trusted) {
      return false;
    }
    if (trusted.startsWith("*.")) {
      return hostname.endsWith(trusted.slice(1));
    }
    return hostname === trusted;
  });
}
