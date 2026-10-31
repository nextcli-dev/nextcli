/**
 * Writes Cloudflare Pages redirects from docs/docs.json.
 * Static export cannot use Next.js redirects, and the old HTML pages
 * sent visitors to /docs/... which 404s on docs.nextcli.dev.
 *
 * Run via: npx tsx scripts/write-redirects.ts
 */
import fs from "fs";
import path from "path";

const DOCS_DIR = path.resolve(__dirname, "../../docs");
const OUT_FILE = path.resolve(__dirname, "../public/_redirects");

type NavItem = string | { pages?: NavItem[] };

function collectPages(items: NavItem[] | undefined, out: Set<string>) {
  for (const item of items ?? []) {
    if (typeof item === "string") out.add(item);
    else if (item.pages) collectPages(item.pages, out);
  }
}

function pathWithoutHash(url: string): string {
  const hash = url.indexOf("#");
  return hash === -1 ? url : url.slice(0, hash);
}

function oneToken(url: string): string {
  return url.replace(/\s/g, "%20");
}

function main() {
  const docsJsonPath = path.join(DOCS_DIR, "docs.json");
  const raw = JSON.parse(fs.readFileSync(docsJsonPath, "utf8"));

  const pages = new Set<string>();
  for (const tab of raw.navigation?.tabs ?? []) {
    for (const group of tab.groups ?? []) {
      collectPages(group.pages, pages);
    }
  }

  const lines: string[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  for (const entry of raw.redirects ?? []) {
    const rawSource = String(entry.source);
    const sourcePath = pathWithoutHash(rawSource);
    const key = sourcePath.replace(/^\//, "");
    if (!key || pages.has(key)) {
      skipped += 1;
      console.warn(`skip redirect for live page: ${rawSource}`);
      continue;
    }
    if (seen.has(key)) {
      skipped += 1;
      console.warn(`skip duplicate redirect path: ${rawSource}`);
      continue;
    }
    seen.add(key);

    let destination = String(entry.destination);
    if (
      !destination.startsWith("/") &&
      !destination.startsWith("http://") &&
      !destination.startsWith("https://")
    ) {
      destination = `/${destination}`;
    }
    const line = `${oneToken(sourcePath)} ${oneToken(destination)} 301`;
    const tokens = line.split(/\s+/);
    if (tokens.length !== 3) {
      throw new Error(`redirect is not 3 tokens: ${line}`);
    }
    lines.push(line);
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, `${lines.join("\n")}\n`);
  console.log(
    `Wrote ${lines.length} redirects to public/_redirects (${skipped} skipped)`,
  );
}

main();
