# Automate

A pipeline keeps the data file in step with a source system: export the entries, apply them, prune what the source dropped.

## Step 1 - Apply a file of entries

1. Write the export of the source system

   ```bash exec
   mkdir -p sync && cat > sync/apps.yaml <<'EOF'
   app_1042:
     name: Storefront
     parent_project: applications
     account_links:
       - account: "210987654321"
         environment: PRODUCTION
   app_7:
     name: Search
     parent_project: applications
   EOF
   ```

   > [!NOTE]
   > Entries under their keys, the shape `get` and `list -o yaml` print.
   > JSON works as well, being valid YAML.
   > The file sits in `sync/` so it is not taken for a data file of the directory.

2. Apply it, pruning the `app_` entries it does not hold

   <!-- verify: expect="projects/app_7 created" -->

   ```bash exec
   yamlctl projects apply -f sync/apps.yaml --prune --prefix app_
   ```

3. Run it again

   <!-- verify: expect="projects/app_7 unchanged" -->

   ```bash exec
   yamlctl projects apply -f sync/apps.yaml --prune --prefix app_
   ```

## Step 2 - The source changes

1. `app_1042` is renamed and `app_7` is gone

   ```bash exec
   cat > sync/apps.yaml <<'EOF'
   app_1042:
     name: Storefront v2
     parent_project: applications
     account_links:
       - account: "210987654321"
         environment: PRODUCTION
   EOF
   ```

2. Apply it

   <!-- verify: expect="projects/app_7 pruned" -->

   ```bash exec
   yamlctl projects apply -f sync/apps.yaml --prune --prefix app_
   ```

   > [!IMPORTANT]
   > `--prune` deletes only keys under `--prefix`, the entries the sync owns.
   > `billing_api` and every other entry written by hand stay.

## Step 3 - Output for a pipeline

1. The resource paths of what was applied

   <!-- verify: expect="projects/app_1042" -->

   ```bash exec
   yamlctl projects apply -f sync/apps.yaml --prune --prefix app_ -o name
   ```

2. An entry as JSON

   <!-- verify: expect="210987654321" -->

   ```bash exec
   yamlctl projects get app_1042 -o json
   ```

3. The whole directory against its schemas, the exit status being the result

   <!-- verify: expect="entries, valid" -->

   ```bash exec
   yamlctl check && echo "exit $?"
   ```

## Step 4 - Edit in bulk

1. Export every project

   ```bash exec
   yamlctl projects list -o yaml > sync/projects.yaml
   ```

2. Rename `billing_api` in [sync/projects.yaml](:open:sync/projects.yaml), or run

   ```bash exec
   sed -i 's/name: Billing API/name: Billing/' sync/projects.yaml
   ```

3. Apply it back

   <!-- verify: expect="projects/billing_api configured" -->

   ```bash exec
   yamlctl projects apply -f sync/projects.yaml
   ```

   > [!NOTE]
   > `apply -f` merges each entry into the one there, as `kubectl apply` does: a field left out is kept, a field set to `null` is removed.
   > `replace -f` takes each entry whole.
