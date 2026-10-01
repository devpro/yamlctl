# Labs

Interactive labs for yamlctl, written for [sidelab](https://github.com/devpro/sidelab).

Lab                            | Covers
-------------------------------|------------------------------------------------------------------------------------------------
[quick-demo](quick-demo/)      | Reading, writing, refusals, a sync with `apply -f --prune`, output for a pipeline, a remote schema

## Shape of a lab

A lab is a directory of numbered steps, each holding an `index.md` and a `step.yaml`, with `lab.yaml` at the root carrying the title, the duration and the environment.
`files/` holds what the lab copies into its working directory, and is not a step since it has no `index.md`.

A fenced block marked ` ```bash exec ` renders a **Run** button.

## Keeping a lab working

From a sidelab checkout, against a running launcher:

```bash
npm run verify:course -- ../yamlctl/labs/quick-demo --capabilities network
```

Without `--capabilities` the run only checks that the lab parses, since installing Node.js and yamlctl needs the network.

A block fails when it exits non-zero, so a block showing a refusal ends with `; echo "exit $?"`: the status stays visible and the block passes.
What a block must print is written beside it, and names something the output holds and the command text does not:

````markdown
<!-- verify: expect="projects/billing_api created" -->

```bash exec
yamlctl projects create billing_api name="Billing API"
```
````

## Version pinning

A lab installs the published package, `YAMLCTL_VERSION` in `lab.yaml`, not the working tree.
`quick-demo` needs **0.1.2**, the first release with the kubectl verbs, `-f` files, `--prune` and `-o` on writes.
