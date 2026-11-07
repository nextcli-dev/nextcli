// Installs the marketplace extensions the VS Code e2e tests need.
//
// Every e2e job installs them at the same time. The gallery sometimes answers
// with "Server returned 503", which fails the job before any test runs.
// Retry when the failure is a transient gallery or network error. Anything
// else fails immediately.
const { spawnSync } = require("child_process");
const path = require("path");

const EXTENSIONS = [
  "ms-vscode-remote.remote-ssh",
  "ms-vscode-remote.remote-containers",
  "ms-vscode-remote.remote-wsl",
];

const ATTEMPTS = 4;

function marketplaceArgs(extensionId) {
  return [
    "install-from-marketplace",
    extensionId,
    "--extensions_dir",
    "./e2e/.test-extensions",
    "--storage",
    "./e2e/storage",
  ];
}

function isTransientMarketplaceError(output) {
  return /server returned (?:429|502|503|504)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed/i.test(
    output ?? "",
  );
}

// attempt is the try that just failed, starting at 1. 2s, 4s, 8s, plus up
// to a second of jitter so parallel jobs do not retry in lockstep.
function delayForAttempt(attempt, random = Math.random) {
  return 2000 * 2 ** (attempt - 1) + Math.floor(random() * 1000);
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function extestCli() {
  const pkgPath = require.resolve("vscode-extension-tester/package.json");
  return path.join(
    path.dirname(pkgPath),
    require("vscode-extension-tester/package.json").bin.extest,
  );
}

function runExtest(extensionId) {
  const result = spawnSync(
    process.execPath,
    [extestCli(), ...marketplaceArgs(extensionId)],
    {
      encoding: "utf8",
    },
  );
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join("\n");
  return { status: result.status ?? 1, output };
}

function installExtension(extensionId, options = {}) {
  const attempts = options.attempts ?? ATTEMPTS;
  const run = options.run ?? runExtest;
  const sleep = options.sleep ?? sleepMs;
  const log = options.log ?? console.error;
  const delay = options.delay ?? delayForAttempt;

  let last = { status: 1, output: "" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = run(extensionId);
    if (last.status === 0) {
      return { ok: true, status: 0, attempts: attempt };
    }
    const transient = isTransientMarketplaceError(last.output);
    if (!transient || attempt === attempts) {
      return {
        ok: false,
        status: last.status || 1,
        attempts: attempt,
        transient,
      };
    }
    const wait = delay(attempt);
    log(
      `Installing ${extensionId} hit a transient marketplace error (attempt ${attempt}/${attempts}). Retrying in ${wait / 1000}s.`,
    );
    sleep(wait);
  }
  return { ok: false, status: last.status || 1, attempts, transient: true };
}

function main() {
  for (const extensionId of EXTENSIONS) {
    const result = installExtension(extensionId);
    if (!result.ok) {
      const reason = result.transient
        ? `still failing after ${result.attempts} attempts`
        : "failed";
      console.error(`Installing ${extensionId} ${reason}.`);
      process.exit(result.status);
    }
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  EXTENSIONS,
  marketplaceArgs,
  isTransientMarketplaceError,
  delayForAttempt,
  installExtension,
};
