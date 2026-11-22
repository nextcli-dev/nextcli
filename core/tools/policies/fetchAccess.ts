/**
 * Hosts the user trusts for the Read URL tool (fetch_url_content): a fetch
 * of an https URL on one of them runs without asking. A URL can carry data
 * out, so the list starts empty and only the user adds to it.
 */

// A host name with at least two labels, optionally behind "*." for its
// subdomains. Bare names (localhost) and "*.com" don't qualify.
const HOST_PATTERN =
  /^(\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_PATTERN = /^\d+(?:\.\d+){3}$/;

/**
 * The form a trusted-host entry is stored in, or undefined when the text
 * isn't a host name: "GitHub.com", "https://github.com/org" and
 * "github.com/" all give "github.com"; "*.github.com" stays a wildcard.
 * Entries with a port or an IP address are refused: a fetch is trusted only
 * on the default https port, and an address could point into a private
 * network.
 */
export function normalizeTrustedHost(entry: string): string | undefined {
  let host = entry.trim().toLowerCase();
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.replace(/[/?#].*$/, "");
  host = host.replace(/\.$/, "");
  if (!HOST_PATTERN.test(host)) {
    return undefined;
  }
  if (IPV4_PATTERN.test(host.replace(/^\*\./, ""))) {
    return undefined;
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
