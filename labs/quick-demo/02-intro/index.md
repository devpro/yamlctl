# yamlctl

A command line reading and editing YAML data files entry by entry, every change checked against the file's JSON Schema.

---

## The problem

YAML data files drive Terraform, GitOps and CI, and are edited by people and pipelines alike.

- A typo, a wrong value or a dangling reference is found by `terraform plan` at best.
- `sed` and `yq` edit text, not data: no type, no check, comments at risk.

---

## The answer

Feature              | What it means
---------------------|------------------------------------------------------------------------------
Schema-driven        | The file names its JSON Schema, and every write is checked against it
kubectl verbs        | `get`, `create`, `apply`, `patch`, `replace`, `delete`, `explain`
Careful              | Comments, order and other entries untouched, nothing written when nothing changed
Pipeline-ready       | `-f` files, `--prune`, `-o json\|yaml\|name`, a non-zero exit on any refusal

---

## Grammar

```text
yamlctl <resource> <verb> [key] [field=value...] [-f file]
```

A resource is a file stem, `project` for `project.yaml`, or a map of entries inside a file.
