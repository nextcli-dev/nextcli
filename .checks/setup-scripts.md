---
name: Setup Scripts
description: Keep the development setup scripts in sync with build changes
paths:
  - "**/package.json"
  - "scripts/**"
  - ".nvmrc"
  - ".node-version"
  - "packages/*/**"
---

The setup scripts take a contributor from a fresh clone to a working environment:

- `scripts/install-dependencies.sh` and `scripts/install-dependencies.ps1` install dependencies for every part of the repository.
- `scripts/build-packages.js` builds everything in `packages/`, in dependency order.

Fail if this pull request changes the build in a way these scripts don't handle, for example:

- A new package under `packages/`, or a new dependency between packages, that `build-packages.js` doesn't build or builds in the wrong order.
- A new directory with its own `package.json` that the install scripts don't install.
- A new required tool or Node version that the install scripts don't check for or set up. `.nvmrc` is the Node version source.
- A change to one install script that isn't mirrored in the other (`.sh` and `.ps1`).

Pass when the pull request only changes source code, tests or docs inside existing packages.
