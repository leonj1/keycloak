# Contributing

Follow the [coding guidelines](js/CODING_GUIDELINES.md) and [standalone setup](README.md#build-and-start).
Use the repository's issue templates for bug reports and enhancements.
Follow [SECURITY.md](SECURITY.md) when reporting vulnerabilities.

## Verification

Run the following from `js/`.

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:proxy
```

Run the [browser acceptance test](README.md#verify) against Rust when changing console authentication or admin API behavior.

## Submitting changes

Sign off each commit with `git commit --signoff` under the [Developer Certificate of Origin](https://developercertificate.org/).
Link the relevant issue in the pull request.
Disclose material use of an AI agent in the pull request description.
Review generated changes, understand how they work, and verify compliance with the [Apache 2.0 license](LICENSE.txt).
