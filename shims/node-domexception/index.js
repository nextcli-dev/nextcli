// Stand-in for the deprecated node-domexception package (every published
// version is deprecated: "Use your platform's native DOMException instead").
//
// fetch-blob (via node-fetch 3), formdata-node (via openai) and gaxios (via
// google-auth-library) still depend on it. Each package that installs them
// lists this folder as a direct `file:` dependency named node-domexception,
// which npm then uses for those packages too (their ranges accept 1.0.0).
// Not an `overrides` entry: npm writes a broken lockfile path for a relative
// `file:` override, and `npm ci` then fails.
// The original only added a polyfill for Node versions without a global
// DOMException; every Node version nextcli supports (22 and newer) has one.
"use strict";

module.exports = globalThis.DOMException;
