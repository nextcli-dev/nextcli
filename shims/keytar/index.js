// Stand-in for keytar, backed by @napi-rs/keyring.
//
// keytar is archived (7.9.0 is its last release) and downloads its native
// binary with prebuild-install, which npm marks deprecated. @napi-rs/keyring
// ships prebuilt binaries as optional dependencies instead.
//
// docs/ needs it only because @mintlify/cli lists keytar as an optional
// dependency, for `mintlify login`. docs/ lists this folder as a direct
// `file:` dependency named keytar, which npm then uses for @mintlify/cli too
// (it pins 7.9.0, this package's version). See shims/node-domexception for why
// this isn't an `overrides` entry.
//
// Both libraries store credentials in the OS keychain under the same service
// and account, so credentials saved by keytar stay readable (checked on
// macOS). keytar's promise API: missing credentials resolve to null, and
// deleting one that doesn't exist resolves to false.
"use strict";

const { AsyncEntry, findCredentialsAsync } = require("@napi-rs/keyring");

module.exports = {
  getPassword: (service, account) =>
    new AsyncEntry(service, account).getPassword(),
  setPassword: (service, account, password) =>
    new AsyncEntry(service, account).setPassword(password),
  deletePassword: (service, account) =>
    new AsyncEntry(service, account).deletePassword(),
  findCredentials: async (service) =>
    (await findCredentialsAsync(service)).map(({ account, password }) => ({
      account,
      password,
    })),
  findPassword: async (service) => {
    const [first] = await findCredentialsAsync(service);
    return first ? first.password : null;
  },
};
