/**
 * Resolve internal paths for the standalone docs app.
 *
 * On the docs subdomain, /docs/X becomes /X (we're already on docs.nextcli.dev).
 * Cross-app links get absolute URLs.
 */
export function resolveHref(path: string): string {
  // Strip /docs prefix — we're already on the docs domain
  if (path.startsWith("/docs/")) return path.slice(5);
  if (path === "/docs") return "/";

  // The marketing site is the apex domain. Docs have no blog or login.
  if (path === "/") return "https://nextcli.dev";

  // Everything else stays as-is
  return path;
}
