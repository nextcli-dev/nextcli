#!/usr/bin/env node
// Checks the images in the READMEs that ship with a release (the VS Code
// extension page on the Marketplace and Open VSX, and the CLI page on npm).
//
// Those pages load each image from the URL in the README, so a bad URL ships
// as a broken-image icon, and the page can't be fixed without a new release.
// What broke the extension page: URLs of the form
//   https://github.com/nextcli-dev/nextcli/raw/HEAD/<path>
// go through a redirect that GitHub answers with 504 under load. The same file
// on raw.githubusercontent.com is served directly.
//
// Rules for every image in a README:
//   - the URL is absolute https (a relative path only works if the packager
//     rewrites it, and then it points at the same flaky github.com URL);
//   - the host is raw.githubusercontent.com (or the badge host img.shields.io);
//   - a file in this repository on main or HEAD exists in the working tree.
//
// Usage:
//   node scripts/ci/check-readme-images.mjs [--live] [--no-local] [README...]
//     --live      also fetch every URL and expect an image (before a release)
//     --no-local  skip the "file exists in this repository" check, for a README
//                 taken out of a built package
// With no README arguments it checks the READMEs listed in README_FILES.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const README_FILES = [
  "extensions/vscode/README.md",
  "extensions/cli/README.md",
];

const ALLOWED_HOSTS = new Set(["raw.githubusercontent.com", "img.shields.io"]);
const OWN_RAW =
  /^https:\/\/raw\.githubusercontent\.com\/nextcli-dev\/nextcli\/([^/]+)\/(.+)$/;

/** Every image URL in a Markdown file: ![alt](url "title") and <img src="url"> */
export function imageRefs(markdown) {
  // Images inside fenced code blocks are examples, not images
  const text = markdown.replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const urls = [];
  for (const m of text.matchAll(
    /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g,
  )) {
    urls.push(m[1]);
  }
  for (const m of text.matchAll(/<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi)) {
    urls.push(m[1]);
  }
  return urls;
}

/**
 * The problems with the images of one README, as { url, problem }.
 * `exists(repoPath)` says whether a file is in this repository; leave it out to
 * skip that check.
 */
export function checkImages(markdown, { exists } = {}) {
  const problems = [];
  for (const url of imageRefs(markdown)) {
    if (url.startsWith("data:")) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      problems.push({
        url,
        problem:
          "is not an absolute URL. Use https://raw.githubusercontent.com/nextcli-dev/nextcli/main/<path>",
      });
      continue;
    }
    if (parsed.protocol !== "https:") {
      problems.push({ url, problem: "is not https" });
    } else if (parsed.hostname === "github.com") {
      problems.push({
        url,
        problem:
          "goes through github.com, which redirects and answers 504 under load. Use https://raw.githubusercontent.com/nextcli-dev/nextcli/main/<path>",
      });
    } else if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      problems.push({
        url,
        problem: `is on ${parsed.hostname}. Allowed: ${[...ALLOWED_HOSTS].join(", ")}`,
      });
    } else if (exists) {
      const own = OWN_RAW.exec(url);
      if (own && (own[1] === "main" || own[1] === "HEAD")) {
        const repoPath = decodeURIComponent(own[2].split(/[?#]/)[0]);
        if (!exists(repoPath)) {
          problems.push({
            url,
            problem: `points at ${repoPath}, which is not in the repository`,
          });
        }
      }
    }
  }
  return problems;
}

/**
 * Fetches each URL and expects an image. A few tries each, since the point is
 * to catch an image that is gone, not one that fails once.
 */
export async function checkLive(
  urls,
  { fetchImpl = fetch, tries = 3, delayMs = 2000 } = {},
) {
  const problems = [];
  for (const url of urls) {
    let last = "";
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const res = await fetchImpl(url, { redirect: "follow" });
        const type = res.headers.get("content-type") ?? "";
        if (res.status === 200 && type.startsWith("image/")) {
          last = "";
          break;
        }
        last = `answered ${res.status} ${type}`.trim();
      } catch (error) {
        last = `could not be fetched: ${error.message}`;
      }
      if (attempt < tries) await new Promise((r) => setTimeout(r, delayMs));
    }
    if (last) problems.push({ url, problem: last });
  }
  return problems;
}

async function main(argv) {
  const live = argv.includes("--live");
  const local = !argv.includes("--no-local");
  const files = argv.filter((a) => !a.startsWith("--"));
  const root = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../..",
  );
  const targets = files.length
    ? files
    : README_FILES.map((f) => path.join(root, f));

  let failed = false;
  const urls = new Set();
  for (const file of targets) {
    const text = fs.readFileSync(file, "utf8");
    const problems = checkImages(text, {
      exists: local ? (p) => fs.existsSync(path.join(root, p)) : undefined,
    });
    for (const { url, problem } of problems) {
      console.error(`${path.relative(process.cwd(), file)}: ${url} ${problem}`);
      failed = true;
    }
    imageRefs(text)
      .filter((u) => u.startsWith("https://"))
      .forEach((u) => urls.add(u));
  }
  if (live) {
    for (const { url, problem } of await checkLive([...urls])) {
      console.error(`${url} ${problem}`);
      failed = true;
    }
  }
  if (!failed) {
    console.log(
      `README images OK (${urls.size} checked${live ? ", live" : ""})`,
    );
  }
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
