// Entry point for `npm run dev`, the same as the dist/cn.js wrapper that
// build.mjs writes: the bootstrap finishes before index.js is imported.
import { prepareEnvironment } from "./bootstrap.js";

await prepareEnvironment();
const { runCli } = await import("./index.js");
await runCli();
