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

The same tests with their coverage, written to coverage/lcov.info:

```bash
npm run test:coverage
```

Test the packed tarball installed in an empty project:

```bash
npm run smoke
```

> [!NOTE]
> Both run in CI on Node.js 22, 24 and 26.

## Layout

```txt
bin/yamlctl.js       entry point
docs/                schema-extensions.md, the x-yamlctl keywords
examples/            the data file and schema the README runs against
scripts/             smoke_pack.sh
src/                 one module per concern, described in AGENTS.md
test/                one test file per module, and fixtures/workspace
```

## Run the pipeline locally

[IstarCI](https://github.com/devpro/istarci) runs the GitHub Actions pipeline in Docker before the push.
`istarci add` and `istarci install-hook` set it up for this repository.

## Code analysis

The Node.js 24 test job analyzes the code on [SonarCloud](https://sonarcloud.io), from `sonar-project.properties` and the settings of the GitHub repository:

Setting             | Kind     | Value
--------------------|----------|--------------------------------------------
`SONAR_ORG`         | Variable | SonarCloud organization
`SONAR_PROJECT_KEY` | Variable | SonarCloud project key
`SONAR_HOST_URL`    | Variable | Optional, `https://sonarcloud.io` if absent
`SONAR_TOKEN`       | Secret   | Token of the SonarCloud organization

IstarCI runs the same analysis against its local SonarQube, and fails the run when the quality gate fails:

```bash
istarci wait               # the result of the run of the last commit
istarci sonarqube report   # why the quality gate failed
```

An accepted finding goes in `sonar-project.properties` with its reason above it, never in the interface of Sonar.
