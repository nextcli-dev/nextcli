---
name: Model catalog
description: Model metadata, pricing, tool support and provider endpoints
alwaysApply: false
globs:
  - "**/packages/llm-info/**"
  - "**/packages/openai-adapters/**"
  - "**/core/llm/**"
  - "**/extensions/cli/src/util/tokenizer.ts"
paths:
  - "**/packages/llm-info/**"
  - "**/packages/openai-adapters/**"
  - "**/core/llm/**"
  - "**/extensions/cli/src/util/tokenizer.ts"
---

# Model catalog

Per-model data comes from the models.dev snapshot in `packages/llm-info`, refreshed by `sync-models.yml`. `MAINTAINING.md` ("Model catalog") has the release side.

- **No per-model numbers in code.** Don't add limits, efforts or prices for a model to `packages/openai-adapters/src/modelControls.ts` or anywhere else. Per-family protocol rules (how thinking turns off) stay there; live-checked corrections go in `catalogOverrides.ts`, dated.
- **Missing from models.dev.** Add a sourced, dated entry to `packages/llm-info/src/supplement.ts` and leave out fields the vendor doesn't publish. Lookups use `findCatalogModel` / `matchCatalogs`: an exact match beats a variant, and models.dev comes before the supplement.
- **Reuse the exports.** `resolveCatalog`, `catalogToolSupport`, `findCatalogModel` and the endpoint helpers exist; don't write a second lookup. The snapshot keeps only fields some code reads.
- **Tool support.** `PROVIDER_TOOL_SUPPORT` (`core/llm/toolSupport.ts`) decides wherever it has a rule; the catalog's `tool_call` decides only for providers without one.
- **Prices.** An unknown price is never zero. A host on this machine (`localhost`, `*.localhost`, `127.x`, `0.0.0.0`, `[::1]`) is never priced; private-network hosts are not local. Maker list prices are exact only on the maker's own API host. A per-model `pricing` in config wins over everything.
- **Endpoints.** Before adding a provider to the no-`/completions` list in `supportsCompletions` (`core/llm/index.ts`), probe the host: an unauthenticated `POST {}` answering 404 means missing, 401 means it exists.
