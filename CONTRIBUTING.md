# Contributing

## Run from the source

Install packages:

```bash
npm install
```

Run the tool:

```bash
node bin/yamlctl.js --help
```

Run examples:

```bash
cd examples &&
node ../bin/yamlctl.js project list
```

> [!TIP]
> `npm link` puts the working copy on the `PATH` as `yamlctl`.

## Test

Unit tests, in process, against a copy of test/fixtures/workspace:

```bash
npm test
```

Test the packed tarball installed in an empty project:

```bash
npm run smoke
```

> [!NOTE]
> Both run in CI on Node.js 20, 22 and 24.

## Layout

```txt
bin/yamlctl.js       entry point
docs/                schema-extensions.md, the x-yamlctl keywords
examples/            the data file and schema the README runs against
scripts/             smoke_pack.sh
src/                 one module per concern, described in AGENTS.md
test/                one test file per module, and fixtures/workspace
```
