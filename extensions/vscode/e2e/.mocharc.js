// Mocha options for the e2e run; the e2e:test script passes this file to
// ExTester with --mocha_config.
module.exports = {
  // One limit for every test and hook. Per-test overrides (up to 21 hours)
  // let a hang run into the CI job timeout, which leaves no screenshot.
  timeout: 180_000,
  // An `.only` left in a test file silently skipped the rest of the file
  // for over a year.
  forbidOnly: true,
};
