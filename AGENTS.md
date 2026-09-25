# yamlctl: agent context

A command line tool reading and editing YAML data files entry by entry, every change checked against the file's JSON Schema.
It knows nothing about what a file describes: every rule comes from the schema, its standard keywords and the `x-yamlctl` extensions documented in `docs/schema-extensions.md`.

```txt
bin/yamlctl.js    the entry point, nothing but the exit status
src/cli.js        the grammar, `yamlctl <resource> <verb>`, and every command
src/resources.js  what a resource name points at: a file and a map of entries in it
src/schema.js     finding, reading and applying a schema, and typing a value from it
src/store.js      every schema document by URI, fetching and caching the remote ones
src/rules.js      the x-yamlctl checks spanning more than one entry
src/document.js   reading and writing a YAML file without disturbing what is not edited
src/explain.js    the schema read back as text
```

Node.js 20 or later, plain JavaScript as ES modules, no build step.
Two dependencies, `yaml` for editing a document in place and `ajv` for validation, and adding a third needs a reason a small function cannot answer.

## Working rules

- Do the work directly, in the foreground.
  No subagents, forks or background tasks unless one is absolutely needed, and ask first even then.
- Linters are never run by an agent, and never imitated by hand either: no `markdownlint`, `yamllint`, `eslint`, no formatter, no rewrapping a paragraph so a tool would be quieter.
  The repository owner runs them and decides about every finding.
  Test commands are not linters.
- Preserve existing comments and formatting when editing a file.
- Commit only when asked, and never push.
  Shell scripts are `snake_case` and committed with the executable bit (`git update-index --chmod=+x`).

## Writing style

Applies to Markdown, code comments, commit messages, command output and prose in scripts.

- **A comment says why, not what, and the why is timeless.**
  The code says what it does.
  A comment records only what cannot be read off it: the failure it prevents, the constraint that made the obvious shape wrong, the alternative rejected and why.
  Never "used to", never "this replaced": a comment is not a conversation log.
- **One thought per line.**
  Every sentence starts on its own line; a long sentence breaks at a clause boundary, never mid-clause and never to fit a width.
  There is no maximum line length.
- **No em dash, no en dash.** A colon, a comma, or a full stop.
- **No second person.** "The working tree", not "your working tree"; `<token>`, not `<your-token>`.

## Design decisions

- **The schema is the only source of knowledge.**
  A rule about a particular kind of data never goes in the code: it goes in the schema, as a standard keyword or an `x-yamlctl` one, and a new `x-yamlctl` keyword is documented in `docs/schema-extensions.md` in the same change.
- **The file is found from the name, the schema from the file.**
  A resource is a file stem or a map name, and the schema is the one the file names on its `yaml-language-server` line, so an editor and yamlctl check against the same schema.
- **Every schema location is an absolute URI with a pointer fragment**, `file:` or `https:`, so a `$ref` into another file or onto the network needs no special case.
  Remote documents are all fetched by `prefetch` before a command runs, which is the only asynchronous step: everything after it, `run` included, stays synchronous.
  They are cached for a day, fall back to a stale copy when a fetch fails, and `--offline` never fetches.
- **A named schema that cannot be loaded blocks a write** and only warns on a read, since checking nothing where the file asked for a check is worse than stopping.
- **A failing alternative is reported through its closest branch**: the value validated against each branch on its own, ranked by type agreement, then by problems on the value itself, then by total, the way established validators pick a best match.
- **A map of entries is recognised by shape**, a top-level property whose `additionalProperties` is an object schema, so a schema needs nothing added to be used.
- **A value is typed by the schema**, never by YAML: `005217217997` stays a string where the schema says string.
- **Nothing is written unless something changed**, and nothing is written at all when a check fails.
  A command run twice is a no-op the second time, which is what makes a sync safe to repeat.
- **Output is for people and pipelines alike**: data on stdout, warnings and errors on stderr, a non-zero exit on any refusal.

## Testing

`npm test` runs `node --test test/*.test.js`, `node:test` and `node:assert/strict`, one file per module.
`src/cli.js` exports `run`, which takes its output functions, so a command is tested in process against a copy of `test/fixtures/workspace`; `test/cli.test.js` also runs the real binary for the shebang and the exit status.
`test/remote.test.js` serves schemas from a real local HTTP server and counts the requests, which is what proves the cache, `--offline` and the fallback rather than a stubbed fetch.
`npm run smoke` packs the tarball, installs it in an empty project and runs it, which is what catches a file left out of `files` or a missing dependency.

Test first whenever the expected behaviour is clear: a bug, a new keyword, a new option.
A test name describes behaviour, and a test asserts on the whole message a person reads rather than on a fragment of it wherever the message is stable.
