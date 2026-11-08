import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  README_FILES,
  checkImages,
  checkLive,
  imageRefs,
} from "./check-readme-images.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const raw = "https://raw.githubusercontent.com/nextcli-dev/nextcli/main";

test("finds Markdown and HTML images, and skips code blocks", () => {
  const md = [
    "![a](https://x.test/a.png)",
    '![b](https://x.test/b.png "title")',
    '<img src="https://x.test/c.png" width="10">',
    "```",
    "![example](https://x.test/example.png)",
    "```",
  ].join("\n");
  assert.deepEqual(imageRefs(md), [
    "https://x.test/a.png",
    "https://x.test/b.png",
    "https://x.test/c.png",
  ]);
});

test("accepts raw.githubusercontent.com for files in the repository", () => {
  const md = `![Agent](${raw}/extensions/vscode/media/readme/agent.gif)`;
  assert.deepEqual(checkImages(md, { exists: () => true }), []);
});

test("rejects the github.com raw URL that returned 504s", () => {
  const url =
    "https://github.com/nextcli-dev/nextcli/raw/HEAD/extensions/vscode/media/readme/agent.gif";
  const problems = checkImages(`![Agent](${url})`);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].url, url);
  assert.match(problems[0].problem, /504/);
});

test("rejects github.com blob URLs, relative paths and http", () => {
  const md = [
    "![a](https://github.com/nextcli-dev/nextcli/blob/main/a.png?raw=true)",
    "![b](media/readme/agent.gif)",
    "![c](http://raw.githubusercontent.com/nextcli-dev/nextcli/main/a.png)",
  ].join("\n");
  assert.equal(checkImages(md).length, 3);
});

test("rejects other hosts, and allows badges", () => {
  assert.equal(checkImages("![x](https://example.com/a.png)").length, 1);
  assert.deepEqual(
    checkImages("![v](https://img.shields.io/badge/a-b-green)"),
    [],
  );
});

test("rejects a file that is not in the repository", () => {
  const md = `![Agent](${raw}/extensions/vscode/media/readme/missing.gif)`;
  const problems = checkImages(md, { exists: () => false });
  assert.equal(problems.length, 1);
  assert.match(problems[0].problem, /not in the repository/);
});

test("the READMEs that ship with a release pass, and their files exist", () => {
  for (const file of README_FILES) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    const problems = checkImages(text, {
      exists: (p) => fs.existsSync(path.join(root, p)),
    });
    assert.deepEqual(problems, [], file);
    assert.ok(imageRefs(text).length > 0, `${file} has no images`);
  }
});

const imageResponse = (status, type = "image/gif") => ({
  status,
  headers: { get: () => type },
});

test("live check passes an image and fails a 504 that doesn't recover", async () => {
  const ok = await checkLive(["https://x.test/ok.gif"], {
    fetchImpl: async () => imageResponse(200),
    delayMs: 0,
  });
  assert.deepEqual(ok, []);

  const bad = await checkLive(["https://x.test/bad.gif"], {
    fetchImpl: async () => imageResponse(504, "text/html"),
    tries: 3,
    delayMs: 0,
  });
  assert.equal(bad.length, 1);
  assert.match(bad[0].problem, /504/);
});

test("live check tolerates a failure that recovers, and rejects a non-image", async () => {
  let calls = 0;
  const recovers = await checkLive(["https://x.test/a.gif"], {
    fetchImpl: async () => imageResponse(++calls < 2 ? 504 : 200),
    delayMs: 0,
  });
  assert.deepEqual(recovers, []);

  const html = await checkLive(["https://x.test/a.gif"], {
    fetchImpl: async () => imageResponse(200, "text/html"),
    tries: 1,
  });
  assert.equal(html.length, 1);
});
