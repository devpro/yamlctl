# Contributing

## Run from the source

```bash
npm install
node bin/yamlctl.js --help
cd examples && node ../bin/yamlctl.js project list
```

`npm link` puts the working copy on the `PATH` as `yamlctl`.

## Test

```bash
npm test           # unit tests, in process, against a copy of test/fixtures/workspace
npm run smoke      # the packed tarball installed in an empty project and run
```

Both run in CI on Node.js 20, 22 and 24.

## Layout

```txt
bin/yamlctl.js       entry point
src/                 one module per concern, described in AGENTS.md
test/                one test file per module, and fixtures/workspace
examples/            the data file and schema the README runs against
docs/                schema-extensions.md, the x-yamlctl keywords
scripts/             smoke_pack.sh
```

## Release

A push to `main` publishes to npmjs.org when `package.json` carries a version not published yet, through `.github/workflows/pkg.yml`.
Publishing uses npm trusted publishing, a short-lived token GitHub Actions obtains through OIDC, so no npm secret is stored in the repository.
It is configured once on npmjs.org, in the package settings under **Trusted Publisher**, naming this repository and `pkg.yml`.
A package has to exist before a trusted publisher can be set on it, so the first version is published once by hand with `npm publish`.

A release is therefore a version bump in `package.json`, merged to `main`.
