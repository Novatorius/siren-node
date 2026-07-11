# Contributing to the Siren SDK for Node.js

Thanks for taking the time to contribute. This document explains how to get set up, run the checks,
and open a pull request.

## Getting started

You'll need Node.js 18 or newer.

```sh
git clone https://github.com/Novatorius/siren-node.git
cd siren-node
npm install
```

## Development workflow

```sh
npm test           # run the test suite (vitest, fully offline — fetch is mocked)
npm run build      # bundle to dist/ (ESM + CJS + .d.ts) with tsup
npm run typecheck  # tsc --noEmit
```

The test suite makes no network calls, so you can run everything locally without credentials.

## Pull requests

1. Fork the repository and create a branch off `main`.
2. Make your change, and add or update tests to cover it. New functionality requires new tests.
3. Make sure `npm test`, `npm run build`, and `npm run typecheck` all pass.
4. Keep the change focused. Unrelated refactors are harder to review — open a separate PR.
5. Update `CHANGELOG.md` under the `Unreleased` heading if your change is user-facing.
6. Open the pull request against `main` and fill out the template. Describe what changed and why.

## Reporting bugs and requesting features

Use the [issue tracker](https://github.com/Novatorius/siren-node/issues) and pick the appropriate
template. For anything security-sensitive, follow [SECURITY.md](./SECURITY.md) instead of opening a
public issue.

## Code of Conduct

By participating in this project you agree to abide by our
[Code of Conduct](./CODE_OF_CONDUCT.md).
