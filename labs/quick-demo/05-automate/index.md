# Automate

A pipeline writes entries from a file rather than one field at a time: `-f` takes entries under their keys, as YAML or JSON, the shape `get` and `list -o yaml` print.

## Step 1 - Several entries at once

1. Write a folder and a project inside it

   ```bash exec
   mkdir -p sync && cat > sync/team.yaml <<'EOF'
   payments:
     name: Payments
     is_folder: true
     parent_project: applications
   payroll_api:
     name: Payroll API
     parent_project: payments
   EOF
   ```

   > [!NOTE]
   > The file sits in `sync/` so it is not taken for a data file of the directory.

2. Create them

   <!-- verify: expect="projects/payroll_api created" -->

   ```bash exec
   yamlctl projects create -f sync/team.yaml
   ```

   > [!NOTE]
   > Every entry is checked against the file as it will be, so `payroll_api` may name a folder created alongside it, and the file is written once, or not at all.

3. Create them again

   <!-- verify: expect="already exists" -->

   ```bash exec
   yamlctl projects create -f sync/team.yaml; echo "exit $?"
   ```

4. Delete the entries the file names

   <!-- verify: expect="projects/payments deleted" -->

   ```bash exec
   yamlctl projects delete -f sync/team.yaml
   ```

## Step 2 - Sync from a source system

A sync keeps the data file in step with a source system: export the entries, apply them, prune what the source dropped.

1. Write the export of the source system

   ```bash exec
   cat > sync/apps.yaml <<'EOF'
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

4. `app_1042` is renamed and `app_7` is gone from the source

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

5. Apply it

   <!-- verify: expect="projects/app_7 pruned" -->

   ```bash exec
   yamlctl projects apply -f sync/apps.yaml --prune --prefix app_
   ```

   > [!IMPORTANT]
   > `--prune` deletes only keys under `--prefix`, the entries the sync owns.
   > `billing_api` and every other entry written by hand stay.

## Step 3 - Output for a pipeline

`-o` turns what a command prints into data: `name` for resource paths, `json` or `yaml` for the entries.

1. The resource paths of what was applied

   <!-- verify: expect="projects/app_1042" -->

   ```bash exec
   yamlctl projects apply -f sync/apps.yaml --prune --prefix app_ -o name
   ```

2. The entry a write left, as YAML

   <!-- verify: expect="description: Checkout" -->

   ```bash exec
   yamlctl projects patch app_1042 description=Checkout -o yaml
   ```

3. An entry as JSON

   <!-- verify: expect="210987654321" -->

   ```bash exec
   yamlctl projects get app_1042 -o json
   ```

4. Every resource path, one per line

   <!-- verify: expect="projects/billing_api" -->

   ```bash exec
   yamlctl projects list -o name
   ```

5. The whole directory against its schemas, the exit status being the result

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

## Step 5 - Replace whole entries

1. Write `billing_api` with only a name and a parent

   ```bash exec
   cat > sync/billing.yaml <<'EOF'
   billing_api:
     name: Billing
     parent_project: applications
   EOF
   ```

2. Replace it

   <!-- verify: expect="projects/billing_api replaced" -->

   ```bash exec
   yamlctl projects replace -f sync/billing.yaml
   ```

3. Get it

   <!-- verify: expect="parent_project: applications" -->

   ```bash exec
   yamlctl projects get billing_api
   ```

   > [!NOTE]
   > `replace -f` takes each entry whole: `account` and `risk_profile`, left out of the file, are gone.
   > It refuses an entry that is not there, where `apply -f` would create it.
