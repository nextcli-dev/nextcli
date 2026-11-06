// Runs vscode-extension-tester's `extest` with the e2e VS Code version from
// package.json (config.e2eVscodeVersion), so get-vscode, get-chromedriver and
// run-tests always agree on it. A Node script rather than
// `$npm_package_config_...` in the npm script, which cmd.exe does not expand.
//
//   node scripts/extest.js <command> [extest options]
//
// For run-tests it also sets NODE_ENV=e2e and passes the test files from
// TEST_FILE, defaulting to every compiled e2e test.
const { spawnSync } = require("child_process");
const path = require("path");

const { config } = require("../package.json");

const [command, ...options] = process.argv.slice(2);
if (!command) {
  console.error("Usage: node scripts/extest.js <command> [extest options]");
  process.exit(1);
}

const args = [command];
const env = { ...process.env };
if (command === "run-tests") {
  args.push(process.env.TEST_FILE || "./e2e/_output/tests/*.test.js");
  env.NODE_ENV = "e2e";
}
args.push(...options, "--code_version", config.e2eVscodeVersion);

const cli = path.join(
  path.dirname(require.resolve("vscode-extension-tester/package.json")),
  require("vscode-extension-tester/package.json").bin.extest,
);
const result = spawnSync(process.execPath, [cli, ...args], {
  stdio: "inherit",
  env,
});
process.exit(result.status ?? 1);
