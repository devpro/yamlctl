# Schema extensions

`x-yamlctl` enriches JSON Schema with additional fields and rules.

> [!NOTE]
> `yamlctl` does not need `x-yamlctl` to run, but it can do additional checks with it, for example when a field refers to another entry of the same file.
> The schema itself is applied by [ajv](https://ajv.js.org/).

## Example

Consider a hierarchy of projects:

```yaml
projects_defaults:
  is_folder: false

projects:
  platform:
    name: Platform
    is_folder: true
  billing:
    name: Billing
    parent_project: platform
```

## Rules on the map

These rules go on the property that holds the entries, here `projects`, next to its `additionalProperties`:

```json
"x-yamlctl": { "defaults": "projects_defaults", "title": "name", "singular": "project" }
```

- `defaults` names the property holding default values.
  When an entry leaves a field out, the value is read from there, so `billing` is treated as `is_folder: false`.
- `title` is the field that `yamlctl projects list` shows beside each key.
  It is `name` when not set.
- `singular` is a second name the command line accepts for the map, so `yamlctl project list` reads `projects` as `yamlctl projects list` does.
  Everything printed still names the map, `projects/billing created`, so the singular is a shortcut to type rather than a second name to read.
  It is never derived from the map's name, since English plurals do not reverse reliably, and a map declaring none is reached by its own name alone.

A property is treated as a map of entries when its `additionalProperties` is an object schema, as `projects` is.
When such a property holds something else, settings grouped by environment for instance, `"x-yamlctl": { "entries": false }` on it tells `yamlctl` to leave it alone.

## Rules on a field

These rules go on a field of the entry, here `parent_project`:

```json
"x-yamlctl": {
  "key-of": ".",
  "target-must": { "is_folder": true },
  "immutable": "moving a project recreates it"
}
```

- `key-of` means the value must be the key of an existing entry.
  `"."` is the same map, here `projects`, and any other value is the name of another map in the file.
  So `billing` can point at `platform`, but not at a project that does not exist, and not at itself.
- `target-must` lists values the pointed entry must have.
  Here `platform` must be a folder.
- `immutable` means the value cannot be changed on an existing entry without `--force`.
  When the value is a text, it is shown to explain why.

`delete` refuses to remove `platform` while `billing` still points at it.
`check` applies `key-of` and `target-must` to the whole file, so that manual edits are caught too.
