# node-domexception shim

Replaces the deprecated `node-domexception` npm package with the platform's
`DOMException`. See `index.js` for why, and `scripts/ci/deprecations-allowlist.json`
history for the phase that introduced it.

Add it as a direct dependency of each package whose dependencies pull in
`node-domexception`, with the path relative to that package's `package.json`
(`devDependencies` in packages published to npm):

```json
"dependencies": { "node-domexception": "file:../shims/node-domexception" }
```

npm then uses the shim for every dependent whose range accepts 1.0.0. Don't
use an `overrides` entry: npm writes a broken lockfile path for a relative
`file:` override, and `npm ci` fails with "Missing: node-domexception from
lock file". A change here runs the full CI (`scripts/ci/affected.mjs`).
