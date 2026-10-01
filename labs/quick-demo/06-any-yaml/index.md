# *Optional:* Any YAML file

yamlctl knows nothing about projects: every rule comes from the schema.
A GitHub workflow is checked against its SchemaStore schema, fetched and cached for a day.

1. Write a workflow

   ```bash exec
   mkdir -p .github/workflows && cat > .github/workflows/ci.yml <<'EOF'
   # yaml-language-server: $schema=https://json.schemastore.org/github-workflow.json
   on: push
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - run: npm test
   EOF
   ```

2. Check it

   <!-- verify: requires=network timeout=120 expect="ci.yml: valid" -->

   ```bash exec
   yamlctl -C .github/workflows check
   ```

3. Remove `runs-on` and check again

   <!-- verify: requires=network timeout=120 expect="missing required field runs-on" -->

   ```bash exec
   sed -i '/runs-on/d' .github/workflows/ci.yml && \
   yamlctl -C .github/workflows check; echo "exit $?"
   ```

   > [!TIP]
   > `--offline` reads the cached schema only, for an air-gapped runner.
