/**
 * Regression check for turning web pages into text, the step jsdom, cheerio
 * and their encoding helpers sit under. It runs the app's own extraction code
 * (docs indexing and the @url context provider) over fixed pages and compares
 * the result with golden output recorded before the dependency upgrade.
 *
 * Record the golden output (only before an upgrade, or after an intended change):
 *   UPDATE_REGRESSION_FIXTURES=1 npx vitest run test/regression/htmlExtraction.vitest.ts
 */
import * as cheerio from "cheerio";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { getUrlContextItems } from "../../context/providers/URLContextProvider";
import { htmlPageToArticleWithChunks } from "../../indexing/docs/article";

vi.mock("../../util/fetchFavicon", () => ({
  fetchFavicon: async () => undefined,
}));

const GOLDEN = path.join(__dirname, "../fixtures/regression/html/golden.json");
const UPDATE = process.env.UPDATE_REGRESSION_FIXTURES === "1";

const page = (body: string, head = "<title>Fixture page</title>") =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

const docsBody = `
  <nav><a href="/docs/">Home</a> <a href="/docs/start">Start</a></nav>
  <main>
    <h1>Indexing guide</h1>
    <p>nextcli builds a local index of your code so retrieval stays fast.</p>
    <h2>Embeddings</h2>
    <p>Each chunk is embedded once and cached by its content hash.</p>
    <pre><code class="language-ts">const index = await LanceDbIndex.create(provider, readFile);</code></pre>
    <h2>Docs sites</h2>
    <p>Docs are crawled, split by <strong>h2</strong> sections and embedded.</p>
    <ul><li>Cheerio for static pages</li><li>Chromium for apps that need JavaScript</li></ul>
    <h2>Limits</h2>
    <table><tr><th>Setting</th><th>Default</th></tr><tr><td>maxChunkSize</td><td>512</td></tr></table>
  </main>
  <footer>© nextcli</footer>
  <script>window.analytics = true;</script>
  <style>body { color: red }</style>`;

/** Bytes in a legacy encoding, decoded the way `response.text()` does: as UTF-8. */
const asFetchText = (bytes: number[]) =>
  new TextDecoder("utf-8").decode(new Uint8Array(bytes));

// "Привет, мир" in windows-1251, and "café" in ISO-8859-1.
const CP1251_BYTES = [
  0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x2c, 0x20, 0xec, 0xe8, 0xf0,
];
const LATIN1_BYTES = [0x63, 0x61, 0x66, 0xe9];

const PAGES: Record<string, string> = {
  "docs page with h2 sections": page(docsBody),
  "article without h2": page(`
    <article><h1>Release notes</h1>
    <p>This release replaces the vector store and keeps existing indexes readable.</p>
    <p>Existing users do not need to re-embed anything; the migration copies rows.</p>
    <p>See the changelog for the full list of fixes and the upgrade notes.</p></article>`),
  "entities and whitespace": page(`
    <article><h2>Entities</h2><p>Tom&nbsp;&amp;&nbsp;Jerry &lt;b&gt; &quot;quoted&quot; &#x1F642; &copy;</p>
    <p>   lots    of
    whitespace   </p></article>`),
  "unicode text": page(`
    <article><h2>Unicode</h2><p>Ünïcödé — 日本語のテキスト — עברית — emoji 🙂</p>
    <p>Second paragraph so readability keeps the article together.</p></article>`),
  "windows-1251 page read as UTF-8": page(
    `<article><h2>Legacy</h2><p>${asFetchText(CP1251_BYTES)}</p><p>Recorded as today's behavior: response.text() always decodes UTF-8.</p></article>`,
    `<meta http-equiv="Content-Type" content="text/html; charset=windows-1251"><title>cp1251</title>`,
  ),
  "latin-1 page read as UTF-8": page(
    `<article><h2>Latin</h2><p>${asFetchText(LATIN1_BYTES)}</p><p>Recorded as today's behavior for ISO-8859-1 pages.</p></article>`,
    `<title>latin1</title>`,
  ),
  "malformed html": `<html><head><title>Broken</title><body><article><h2>Unclosed<p>paragraph one<p>paragraph two <b>bold <i>both</b> italic?</i><div>stray</article>`,
  "nested markup and code": page(`
    <article><h2>Code</h2>
    <p>Call <code>retrieve()</code> with <em>care</em> and <a href="https://x.dev/api">the API</a>.</p>
    <pre><code>line 1
  indented line 2
line 3 &lt;tag&gt;</code></pre>
    <blockquote>Quoted <strong>text</strong>.</blockquote></article>`),
};

// For CheerioCrawler's link extraction (same selector, URL and filter logic).
const LINKS_HTML = page(`
  <a href="/docs/start">relative</a>
  <a href="start-two">relative no slash</a>
  <a href="https://docs.example.dev/docs/abs">absolute same host</a>
  <a href="https://other.example.com/x">other host</a>
  <a href="/docs/start#section">anchor</a>
  <a href="/favicon.ico">ignored ending</a>
  <a href="/docs/start">duplicate</a>
  <a>no href</a>
  <a href="/docs/caf%C3%A9">encoded</a>`);

function extractLinks(html: string, location: string): string[] {
  const baseUrl = new URL(location);
  const $ = cheerio.load(html);
  let links: string[] = [];
  $("a").each((_: any, element: any) => {
    const href = $(element).attr("href");
    if (!href) return;
    const parsedUrl = new URL(href, location);
    if (parsedUrl.hostname === baseUrl.hostname) links.push(parsedUrl.pathname);
  });
  links = [...new Set(links)].filter(
    (l) =>
      !l.includes("#") &&
      !["favicon.ico", "robots.txt", ".rst.txt"].some((e) => l.endsWith(e)),
  );
  return links;
}

async function computeAll() {
  const out: Record<string, unknown> = {};
  for (const [name, html] of Object.entries(PAGES)) {
    const url = `https://docs.example.dev/docs/${encodeURIComponent(name)}`;
    const article = await htmlPageToArticleWithChunks(
      { url, path: `/docs/${name}`, content: html },
      512,
    );
    const fetchFn = (async () =>
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as any;
    const [urlItem] = await getUrlContextItems(url, fetchFn);
    out[name] = {
      docsIndexing: article
        ? {
            title: article.article.title,
            components: article.article.article_components,
            chunks: article.chunks.map((c) => ({
              content: c.content,
              otherMetadata: c.otherMetadata,
            })),
          }
        : null,
      urlProvider: { name: urlItem.name, content: urlItem.content },
    };
  }
  out["cheerio link extraction"] = extractLinks(
    LINKS_HTML,
    "https://docs.example.dev/docs/index",
  );
  return out;
}

describe("HTML extraction regression", () => {
  it("matches the output recorded before the dependency upgrade", async () => {
    const actual = await computeAll();
    if (UPDATE) {
      fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
      fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + "\n");
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf8"));
    for (const name of Object.keys(golden)) {
      expect(actual[name], name).toEqual(golden[name]);
    }
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
