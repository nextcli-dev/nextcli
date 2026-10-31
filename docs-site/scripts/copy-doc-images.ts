/**
 * Copies only images referenced from docs MDX, Markdown, or snippets
 * into public/images/docs/. Fails if any copied file is over 25 MiB,
 * which Cloudflare Pages rejects.
 *
 * Run via: npx tsx scripts/copy-doc-images.ts
 */
import fs from "fs";
import path from "path";

const DOCS_DIR = path.resolve(__dirname, "../../docs");
const OUT_DIR = path.resolve(__dirname, "../public/images/docs");
const MAX_BYTES = 25 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([".mdx", ".md", ".jsx", ".js"]);
const ABSOLUTE_IMAGE =
  /\/images\/([A-Za-z0-9_./+-]+\.(?:png|jpe?g|gif|svg|webp|ico))/gi;
const RELATIVE_IMAGE =
  /(\.\.?\/(?:[A-Za-z0-9_./+-]+)\.(?:png|jpe?g|gif|svg|webp|ico))/gi;

function walkTextFiles(dir: string, out: string[]) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "images") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTextFiles(full, out);
    else if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
}

function posixRelative(filePath: string): string {
  return path.relative(DOCS_DIR, path.dirname(filePath)).split(path.sep).join("/");
}

function main() {
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true });
  }

  const files: string[] = [];
  walkTextFiles(DOCS_DIR, files);

  const jobs = new Map<string, string>();
  const missing: string[] = [];

  function add(source: string, destRelative: string) {
    const normalized = path.posix.normalize(destRelative);
    if (normalized.startsWith("..") || path.isAbsolute(normalized)) return;
    const resolved = path.resolve(source);
    const docsRoot = DOCS_DIR.endsWith(path.sep) ? DOCS_DIR : DOCS_DIR + path.sep;
    if (!resolved.startsWith(docsRoot)) return;
    if (!fs.existsSync(resolved)) {
      missing.push(resolved);
      return;
    }
    jobs.set(path.join(OUT_DIR, normalized), resolved);
  }

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const fileDir = posixRelative(file);
    const absoluteImage = new RegExp(ABSOLUTE_IMAGE.source, "gi");
    const relativeImage = new RegExp(RELATIVE_IMAGE.source, "gi");

    for (const match of content.matchAll(absoluteImage)) {
      const rel = match[1]!;
      add(path.join(DOCS_DIR, "images", rel), rel);
    }

    for (const match of content.matchAll(relativeImage)) {
      const relPath = match[1]!;
      const resolved = path.posix.normalize(
        fileDir ? `${fileDir}/${relPath}` : relPath,
      );
      add(path.resolve(path.dirname(file), relPath), resolved);
    }
  }

  const oversized: string[] = [];
  for (const [dest, source] of jobs) {
    const size = fs.statSync(source).size;
    if (size > MAX_BYTES) {
      oversized.push(`${source} (${size} bytes)`);
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
  }

  if (missing.length > 0) {
    console.warn(`Missing ${missing.length} referenced images`);
    for (const item of missing.slice(0, 20)) console.warn(`  ${item}`);
  }

  if (oversized.length > 0) {
    console.error("Refusing to copy images over 25 MiB:");
    for (const item of oversized) console.error(`  ${item}`);
    process.exit(1);
  }

  console.log(`Copied ${jobs.size - oversized.length} referenced images to public/images/docs/`);
}

main();
