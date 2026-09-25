# Schema extensions

JSON Schema describes one value at a time.
A few rules of a data file look at more than one entry: a field naming another entry, a condition on the entry it names, a field whose change has consequences beyond the value.
`yamlctl` reads those from an `x-yamlctl` object in the schema, which every JSON Schema validator ignores, so the same schema still serves an editor and any other tool unchanged.

Every keyword below is optional, and a schema without any of them is used as it is.

## On a map of entries

Declared on the top-level property holding the entries.

```json
"projects": {
  "type": "object",
  "additionalProperties": { "$ref": "#/definitions/project" },
  "x-yamlctl": { "defaults": "projects_defaults", "title": "name" }
}
```

| Keyword | Value | Effect |
|---------|-------|--------|
| `defaults` | the name of a sibling top-level property | the values every entry inherits unless it sets its own, read by the rules below when an entry leaves a field out |
| `title` | a field name, `name` by default | the field `list` shows beside each key |
| `entries` | `false` | the property is not a map of entries, even though its shape says it could be |

A map of entries is otherwise found from its shape alone: a top-level property whose `additionalProperties` is an object schema.
A map of strings, labels or tags, is a map of values and never a map of entries.

## On a field of an entry

Declared on a top-level field of the entry schema.

```json
"parent_project": {
  "type": ["string", "null"],
  "x-yamlctl": {
    "key-of": ".",
    "target-must": { "is_folder": true },
    "immutable": "moving a project recreates it"
  }
}
```

| Keyword | Value | Effect |
|---------|-------|--------|
| `key-of` | `.` for the map the field belongs to, or the name of another map of the same file | the value, or every item of a list, is the key of an entry of that map, which must exist; an entry naming itself is refused |
| `target-must` | an object of field names and values | the entry named has those values, read with that map's defaults applied |
| `immutable` | `true`, or the reason as text | changing the value on an existing entry needs `--force`, and the reason is shown |

`delete` refuses to remove an entry another one still names through `key-of`, in any map of the file.
`check` applies `key-of` and `target-must` to every entry, since a file edited by hand never went through `set`; `immutable` only concerns a change, so `check` does not apply it.

## Validation

The schema itself is applied by [ajv](https://ajv.js.org/), with drafts 07, 2019-09 and 2020-12 chosen from `$schema`.
Formats are not validated and unknown keywords are tolerated, since a schema written for an editor carries both and neither says anything about validity.
References are followed across files and addresses, resolved against the document's `$id` when it has one, and a remote document is fetched and cached as the README describes.
