import type { CatalogModel } from "./catalogTypes.js";

/**
 * NextCLI's own descriptions of models the models.dev snapshot
 * (generated/catalog.ts) doesn't list yet, in the same shape and under the
 * same models.dev provider ids. The sync never writes this file.
 *
 * findCatalogModel reads the snapshot first and this file only when the
 * snapshot has no match for the model, so models.dev always wins. Each entry
 * says where its values come from and when they were read. Delete an entry
 * once models.dev lists the model: a test in openai-adapters
 * (modelProfile.test.ts) fails when it does, and the weekly sync pull request
 * lists that test.
 *
 * Leave out what the source doesn't say. An absent `efforts`, for example,
 * makes the menu offer guessed levels marked as a guess.
 */
interface SupplementEntry {
  model: CatalogModel;
  /** Where the values come from */
  source: string;
  /** When they were read, and anything worth knowing about them */
  checked: string;
}

const ENTRIES: Record<string, Record<string, SupplementEntry>> = {
  alibaba: {
    "qwen4-max": {
      model: {
        context: 1_000_000,
        // 991K without thinking; the smaller limit, so a prompt fits either way
        input: 983_000,
        reasoning: true,
        images: true,
        cost: { input: 1.5, output: 4.5, cacheRead: 0.075, cacheWrite: 1.875 },
      },
      source: "https://www.qwencloud.com/models/qwen4-max",
      checked:
        "2026-11-19: limits, image input and prices from the model page. It doesn't list the effort levels the API takes, so none are given.",
    },
  },
};

/** The supplement's models, as {provider: {id: model}} like the snapshot */
export const SUPPLEMENT: Record<
  string,
  Record<string, CatalogModel>
> = Object.fromEntries(
  Object.entries(ENTRIES).map(([provider, models]) => [
    provider,
    Object.fromEntries(
      Object.entries(models).map(([id, entry]) => [id, entry.model]),
    ),
  ]),
);
