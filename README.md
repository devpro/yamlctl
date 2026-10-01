# yamlctl

[![CI](https://github.com/devpro/yamlctl/actions/workflows/ci.yml/badge.svg)](https://github.com/devpro/yamlctl/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/yamlctl)](https://www.npmjs.com/package/yamlctl)

Edit YAML files from the command line.

## Key

- **Kubectl-like**: the verbs are kubectl's and behave like them, `create`, `apply`, `patch`, `replace`, `delete`, with the resource first, `yamlctl project create checkout_api name="Checkout API"`.
- **Checked**: a field that does not exist, a value outside its allowed list, or a reference to a missing entry is refused, and the file is left as it was.
- **Typed by the schema**: a string stays a file even if it looks like a number.
- **Careful with the file**: comments, order and every entry not named stay exactly as they were, and a command changing nothing writes nothing.
- **Nothing to configure**: the schema is the one the file already names for an editor.

## Install

Node.js 20 or later:

```bash
npm install --global yamlctl
yamlctl --help
```

`npx yamlctl <command>` runs it without installing.

## Quick start

`examples/` holds a data file and its schema, and every command below runs in it:

```yaml
# yaml-language-server: $schema=schemas/project.schema.json
projects_defaults:
  archived: false
projects:
  applications:
    name: "Applications"
    is_folder: true
  checkout_api:
    name: "Checkout API"
    parent_project: "applications"
    risk_profile:
      business_impact: "HBI"
```

```text
$ yamlctl resources
RESOURCE   FILE           MAP        ENTRIES   SCHEMA
project    project.yaml   projects   2         schemas/project.schema.json

$ yamlctl project list
KEY            NAME
applications   Applications
checkout_api   Checkout API

$ yamlctl project create billing_api name="Billing API" parent_project=applications account=005217217997 risk_profile.business_impact=MBI
projects/billing_api created

$ yamlctl project get billing_api
billing_api:
  name: Billing API
  parent_project: applications
  account: "005217217997"
  risk_profile:
    business_impact: MBI

$ yamlctl project apply billing_api name="Billing API"
projects/billing_api unchanged
```

What the entries hold is read from the schema, the way `kubectl explain` reads an API:

```text
$ yamlctl project explain
RESOURCE:  projects <object>

FIELDS:
  name            <string>    Display name.
  description     <string>
  archived        <boolean>   An archived project is kept but no longer active.
  is_folder       <boolean>   A folder holds other projects rather than resources.
  parent_project  <string>    Key of the folder holding this project.
  account         <string>    Cloud account number, kept as text so a leading zero survives.
  risk_profile    <object>
  account_links   <[]object>  Cloud accounts whose resources belong to the project.
  tags            <object>    Free-form labels.

$ yamlctl project explain risk_profile.business_impact
FIELD:  risk_profile.business_impact <enum>

DESCRIPTION:
  How much the business depends on the project.

VALUES:
  "LBI", "MBI", "HBI"
```

And what does not fit is refused, with the file untouched and a non-zero exit status, so a pipeline stops on it:

```text
$ yamlctl project patch billing_api risk_profle.business_impact=HBI
error: risk_profle.business_impact: no such field in projects, run yamlctl project explain to list them

$ yamlctl project patch billing_api risk_profile.business_impact=HIGH
projects/billing_api.risk_profile.business_impact: must be one of "LBI", "MBI", "HBI"
error: projects/billing_api not written

$ yamlctl project patch billing_api parent_project=checkout_api
projects/billing_api: parent_project: checkout_api must have is_folder: true, it has null
projects/billing_api: parent_project: changing "applications" to "checkout_api" needs --force, moving a project recreates it
error: projects/billing_api not written

$ yamlctl project delete applications
error: projects/applications is still named by projects/checkout_api, projects/billing_api: delete or change them first
```

## Commands

```text
yamlctl <resource> list                              the entries, one line each
yamlctl <resource> get <key>...                      the entries under their keys, as YAML
yamlctl <resource> create <key> <field>=<value>...   a new entry, refused if the key is taken
yamlctl <resource> create -f <file>                  every entry of the file, refused if a key is taken
yamlctl <resource> apply <key> <field>=<value>...    create the entry, or change the fields given and keep the others
yamlctl <resource> apply -f <file>                   create each entry of the file, or merge it into the one there
yamlctl <resource> patch <key> <field>=<value>...    change the fields given of an existing entry, keep the others
yamlctl <resource> replace -f <file>                 replace each entry of the file whole, refused if one is missing
yamlctl <resource> delete <key>...                   remove the entries
yamlctl <resource> delete -f <file>                  remove the entries the file names
yamlctl <resource> explain [field]                   what the entries hold: fields, types, allowed values
yamlctl <resource> check                             the file against its schema
yamlctl resources                                    every resource in the directory
yamlctl check                                        every file in the directory against its schema
```

The verbs writing an entry follow kubectl:

Verb      | Entry missing                                 | Entry present                     | Input
----------|-----------------------------------------------|-----------------------------------|-----------------------------
`create`  | created                                       | refused                           | `<field>=<value>...` or `-f`
`apply`   | created                                       | configured, or unchanged          | `<field>=<value>...` or `-f`
`patch`   | refused                                       | patched, or patched (no change)   | `<field>=<value>...`
`replace` | refused                                       | replaced, or replaced (no change) | `-f`
`delete`  | refused, or nothing with `--ignore-not-found` | deleted                           | `<key>...` or `-f`

Whatever the verb, an entry holding what it already held is not written.
A command writing several entries checks them all against the file as it will be, so one may name another written alongside it, and writes the file once, or not at all when one of them fails.

Option                  | Action
------------------------|-------------------------------------------------------------------------------------------------
`-C, --dir <dir>`       | the directory holding the data files, the current one by default
`--data-file <file>`    | the data file, for a resource the directory does not name on its own
`-o, --output <format>` | `yaml`, `json` or `name`: the entries, or their resource paths, instead of a table or a sentence
`-f, --filename <file>` | the entries to create, apply, replace or delete, `-` for standard input
`--force`               | accept a change the schema marks immutable
`--ignore-not-found`    | `delete` succeeds without a word when the entry is not there
`--prune`               | `apply -f` also deletes the entries the file does not hold, within `--prefix` or `--all`
`--prefix <prefix>`     | the keys `--prune` may delete, the ones a sync owns
`--all`                 | `--prune` may delete any entry of the map
`--offline`             | read remote schemas from the cache only, never from the network, also `YAMLCTL_OFFLINE=1`
`--refresh`             | fetch remote schemas again even when the cache holds a recent copy

A **resource** is a file, `project` for `project.yaml` or `project.yml`, or a map of entries inside one, `ignore_rules` for the `ignore_rules:` map of whichever file holds it.
A file holding several maps is listed whole by its own name and reached one map at a time by the map's name.

A **field** inside an object is a path, `risk_profile.business_impact`.
A list or an object is written as JSON, `account_links='[{"account": "123", "environment": "PRODUCTION"}]'`, and an empty value, `description=`, removes the field.

A file given with **`-f`** holds entries under their keys, as YAML or JSON, the shape `get` and `list -o yaml` print, so the file itself can be edited and applied back:

```bash
yamlctl project list -o yaml > projects.yaml
# edit projects.yaml
yamlctl project apply -f projects.yaml
```

`apply -f` merges each entry into the one already there, the way `kubectl apply` does: an object merges into the object it meets, a list replaces the list it meets, a field the file leaves out is kept, and a field set to `null` is removed.
`replace -f` takes each entry whole instead.

## The schema

`yamlctl` checks a file against the JSON Schema the file names on its first line, the same comment the [YAML language server](https://github.com/redhat-developer/yaml-language-server) reads, so an editor and `yamlctl` never disagree:

```yaml
# yaml-language-server: $schema=schemas/project.schema.json
```

Without that line, it looks for `schemas/<name>.schema.json`, then `<name>.schema.json`, beside the file.
Without any schema, it still edits the file, checks nothing, and says so.
A file naming a schema that cannot be loaded is read with a warning and never written, since checking nothing where the file asked for a check is worse than stopping.

Drafts 07, 2019-09 and 2020-12 are supported, and a schema can be split across files and addresses: every `$ref` is followed, relative to the document's `$id` when it has one.

A schema named by an `https://` address, the ones [SchemaStore](https://www.schemastore.org/) publishes for instance, is fetched along with every remote document its `$ref`s reach:

```text
$ yamlctl -C .github/workflows check
.github/workflows/ci.yml: valid
.github/workflows/pkg.yml: valid
```

- **Cached**: in `~/.cache/yamlctl`, or `$XDG_CACHE_HOME/yamlctl`, or `YAMLCTL_CACHE_DIR`, and used for a day before it is fetched again, so a pipeline running every few minutes does not download the same schema each time.
- **Resilient**: a fetch that fails falls back to the cached copy, whatever its age, with a warning.
- **Offline**: `--offline`, or `YAMLCTL_OFFLINE=1`, reads the cache only, for an air-gapped runner or a reproducible run.
- **Fresh on demand**: `--refresh` fetches again whatever the cache holds.

When an alternative fails, `oneOf` or `anyOf`, only the branch closest to the value is reported, so a job missing `runs-on` is not also told to add `uses`.

The maps of entries are found from the schema's shape: a top-level property whose values all follow one object schema, `additionalProperties: {"$ref": "#/definitions/project"}`.
Nothing has to be added to a schema for `yamlctl` to use it.

A few checks look at more than one entry, which JSON Schema cannot express: a reference to another entry, a condition on the entry it names, a field whose change has consequences.
Those are declared with `x-yamlctl` on the field, and [docs/schema-extensions.md](docs/schema-extensions.md) describes them.

```json
"parent_project": {
  "type": ["string", "null"],
  "x-yamlctl": { "key-of": ".", "target-must": { "is_folder": true }, "immutable": "moving a project recreates it" }
}
```

## In a pipeline

Data goes to standard output, warnings and errors to standard error, and any refusal exits non-zero, with nothing written.
`-o` turns what a command prints into data rather than a table or a sentence:

```text
$ yamlctl project apply -f entries.yaml -o name
projects/app_1042
projects/app_7

$ yamlctl project patch app_7 name=Seven -o json
{
  "app_7": {
    "name": "Seven",
    "parent_project": "applications",
    "account_links": [
      {
        "account": "1",
        "environment": "PRODUCTION"
      }
    ]
  }
}
```

`-o name` prints the resource path of each entry listed, read or written, `-o json` and `-o yaml` the entries themselves, as written.
`delete` takes `-o name` only, `resources` all three, and `check` none, since its exit status is the result.

## From a source system to a data file

A pipeline keeping a data file in step with another system runs four steps, typically on a schedule:

1. Export the list from the source system, as JSON.
2. Turn it into entries under their keys and `apply -f --prune` them, which also deletes the entries the source no longer holds.
3. Run `yamlctl check`, then whatever reads the file, `terraform plan` for instance.
4. Open a merge request with the change, and apply once it is merged.

```bash
# apps.json: [{"id": "1042", "name": "Checkout API", "account": "123456789012"}, ...]
jq 'map({key: "app_\(.id)", value: {name, parent_project: "applications", account_links: [{account, environment: "PRODUCTION"}]}}) | from_entries' apps.json > entries.json
yamlctl project apply -f entries.json --prune --prefix app_
yamlctl check
```

Three rules keep such a sync safe:

- **The key never changes.** It identifies the entry for whatever reads the file, so it comes from an id the source never changes, `app_1042`, never from a name.
- **A sync owns its entries.** A prefix per source, `app_`, tells its entries from the ones written by hand, and `--prune --prefix app_` deletes only keys carrying it, refusing a file holding any other key.
- **Idempotent by design.** `apply -f --prune` of unchanged entries succeeds without writing, so a sync can simply run again.
  A field the source stops sending is kept by the merge, so the sync sends it as `null` to remove it.

## License

[MIT](LICENSE)
