/**
 * jsdom 29 reads data files relative to its own location (the default
 * stylesheet) and loads css-tree's ESM build, which reads JSON the same way.
 * Both break in a bundle, so the extension, the CLI and Jest bundle jsdom with
 * the plugins in scripts/esbuild-plugins/jsdom.cjs. This builds jsdom the way
 * those builds do, in both output formats, and checks the bundle starts and
 * computes styles. A jsdom upgrade that changes that code fails here, not on
 * a user's machine.
 */
import { execFile } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import * as esbuild from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const coreDir = path.resolve(__dirname, "../..");
const repoRoot = path.resolve(coreDir, "..");
const { jsdomPlugins, buildXhrSyncWorker } = require(
  path.join(repoRoot, "scripts/esbuild-plugins/jsdom.cjs"),
);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jsdom-bundle-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Covers both css-tree entry points: jsdom's own require("css-tree") (computed
// style) and @asamuzakjp/dom-selector's namespace import (querySelector), with
// the selectors production code uses (favicons, doc headings, code renderer).
const PROGRAM = `
import { JSDOM } from "jsdom";
const dom = new JSDOM(
  '<head><link rel="shortcut icon" href="/favicon.ico"></head>' +
    '<style>p { color: blue }</style><p id="a" class="x">hi</p>' +
    '<h2>One</h2><h2>Two</h2><pre><span class="line">x</span></pre>',
);
const doc = dom.window.document;
console.log(
  [
    doc.getElementById("a").textContent,
    doc.querySelector("p.x").id,
    doc.querySelectorAll("h2").length,
    doc.querySelector('link[rel*="icon"]').getAttribute("href"),
    doc.querySelectorAll("pre .line").length,
    dom.window.getComputedStyle(doc.querySelector("p")).color,
  ].join("|"),
);
`;
const EXPECTED = "hi|a|2|/favicon.ico|1|rgb(0, 0, 255)";

async function bundleAndRun(
  format: "cjs" | "esm",
  program = PROGRAM,
  name: string = format,
): Promise<string> {
  const dir = path.join(tmp, name);
  const outfile = path.join(dir, format === "cjs" ? "out.cjs" : "out.mjs");
  await esbuild.build({
    stdin: { contents: program, resolveDir: coreDir, loader: "js" },
    outfile,
    bundle: true,
    format,
    platform: "node",
    // As in the extension and CLI builds
    external: ["canvas", "./xhr-sync-worker.js"],
    banner:
      format === "esm"
        ? {
            js: 'import { createRequire as __cr } from "module"; const require = __cr(import.meta.url);',
          }
        : {},
    plugins: jsdomPlugins(),
    logLevel: "error",
  });
  // jsdom resolves its sync-XHR worker next to the bundle when it loads
  await buildXhrSyncWorker(esbuild, {
    jsdomDir: path.join(coreDir, "node_modules/jsdom"),
    outfile: path.join(dir, "xhr-sync-worker.js"),
  });
  // Not execFileSync: the sync XHR test needs this process's server to answer
  return new Promise((resolve, reject) =>
    execFile(process.execPath, [outfile], { encoding: "utf8" }, (e, out) =>
      e ? reject(e) : resolve(out.trim()),
    ),
  );
}

describe("bundled jsdom", () => {
  it("starts, selects and computes styles in a CommonJS bundle (extension, Jest)", async () => {
    expect(await bundleAndRun("cjs")).toBe(EXPECTED);
  }, 60_000);

  it("starts, selects and computes styles in an ESM bundle (CLI)", async () => {
    expect(await bundleAndRun("esm")).toBe(EXPECTED);
  }, 60_000);

  it("runs a synchronous XMLHttpRequest through the bundled worker", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "Access-Control-Allow-Origin": "*" });
      res.end("synchronous ok");
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    try {
      const program = `
import { JSDOM } from "jsdom";
const { window } = new JSDOM("", { url: ${JSON.stringify(url)} });
const xhr = new window.XMLHttpRequest();
xhr.open("GET", ${JSON.stringify(url)}, false);
xhr.send();
console.log(xhr.status + " " + xhr.responseText);
`;
      expect(await bundleAndRun("cjs", program, "sync-xhr")).toBe(
        "200 synchronous ok",
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);
});
