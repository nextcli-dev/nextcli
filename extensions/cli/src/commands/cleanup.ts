import readline from "node:readline/promises";

import {
  findLegacyEmbeddingsData,
  formatBytes,
  removeLegacyEmbeddingsData,
} from "core/indexing/legacyEmbeddingsData.js";

export interface CleanupOptions {
  /** Delete without asking */
  yes?: boolean;
}

/**
 * `cn cleanup`: deletes the codebase index and @docs data that releases with
 * embeddings left in ~/.continue/index. The CLI never wrote it, but the
 * folder is shared with the VS Code extension.
 */
export async function cleanupCommand(options: CleanupOptions = {}) {
  const found = await findLegacyEmbeddingsData();
  if (!found) {
    console.log(
      "Nothing to clean up: no legacy index data in ~/.continue/index.",
    );
    return;
  }

  console.log(
    "Legacy codebase index and @docs data in ~/.continue/index. NextCLI no longer uses it; only versions 1.6.7 and earlier can.",
  );
  for (const file of found.files) {
    console.log(`  ${file.name}  ${formatBytes(file.bytes)}`);
  }
  if (found.indexRows > 0) {
    console.log(
      `  index.sqlite: ${found.indexRows} rows, about ${formatBytes(found.indexBytes)}`,
    );
  }
  console.log(`Total: ${formatBytes(found.totalBytes)}`);

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      console.error(
        "Not deleted: run `cn cleanup --yes` to delete without a prompt.",
      );
      process.exitCode = 1;
      return;
    }
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await prompt.question("Delete it? [y/N] ");
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("Kept.");
      return;
    }
  }

  await removeLegacyEmbeddingsData();
  console.log(`Deleted ${formatBytes(found.totalBytes)}.`);
}
