# keytar shim

Replaces `keytar` (archived; 7.9.0 is its last release, and it installs its
native binary through the deprecated `prebuild-install`) with
[`@napi-rs/keyring`](https://www.npmjs.com/package/@napi-rs/keyring), which
ships prebuilt binaries as optional dependencies. It implements keytar's
promise API (`getPassword`, `setPassword`, `deletePassword`,
`findCredentials`, `findPassword`); see `index.js`.

Only `docs/` uses it: `@mintlify/cli` lists `keytar` 7.9.0 as an optional
dependency for `mintlify login`. `docs/package.json` lists this folder as a
direct dependency, which npm then uses for `@mintlify/cli` too:

```json
"devDependencies": { "keytar": "file:../shims/keytar" }
```

`docs/.npmrc` sets `install-links=true`, so npm installs the shim as a copy
and installs and locks its own dependency (`@napi-rs/keyring`). With a plain
link npm would skip it, and Node would look for it from `shims/`, not
`docs/`.

Both libraries store credentials in the OS keychain under the same service
and account, so a login saved by `keytar` stays readable (checked on macOS).
