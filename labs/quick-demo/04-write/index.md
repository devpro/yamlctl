# Write

The verbs are kubectl's, and so is what each does with an entry missing or present:

Verb      | Entry missing | Entry present
----------|---------------|----------------------------------
`create`  | created       | refused
`apply`   | created       | configured, or unchanged
`patch`   | refused       | patched, or patched (no change)
`replace` | refused       | replaced, or replaced (no change)
`delete`  | refused       | deleted

## Step 1 - Create and patch

1. Create a project

   <!-- verify: expect="projects/billing_api created" -->

   ```bash exec
   yamlctl projects create billing_api name="Billing API" parent_project=applications \
     account=005217217997 risk_profile.business_impact=MBI
   ```

2. Change one field of another project

   <!-- verify: expect="projects/checkout_api patched" -->

   ```bash exec
   yamlctl projects patch checkout_api description="Payment processing"
   ```

3. Open [project.yaml](:open:project.yaml)

   - `account` is `"005217217997"`, a string, because the schema says string: YAML alone would read a number and drop the leading zero.
   - The comments, the order and the entries not named are as they were.

4. Run the same change again

   <!-- verify: expect="patched (no change)" -->

   ```bash exec
   yamlctl projects patch checkout_api description="Payment processing"
   ```

   > [!NOTE]
   > Nothing is written when nothing changed, so a command run twice is a no-op.

## Step 2 - Apply

`apply` does not care whether the entry is there: it creates it, or changes the fields given and keeps the others.

1. Apply a project that does not exist

   <!-- verify: expect="projects/ledger_api created" -->

   ```bash exec
   yamlctl projects apply ledger_api name="Ledger API" parent_project=applications
   ```

2. Apply one more field to it

   <!-- verify: expect="projects/ledger_api configured" -->

   ```bash exec
   yamlctl projects apply ledger_api description="General ledger"
   ```

3. Run it again

   <!-- verify: expect="projects/ledger_api unchanged" -->

   ```bash exec
   yamlctl projects apply ledger_api description="General ledger"
   ```

## Step 3 - Move and delete

1. Create a second folder

   <!-- verify: expect="projects/platform created" -->

   ```bash exec
   yamlctl projects create platform name=Platform is_folder=true
   ```

2. Move `ledger_api` into it

   <!-- verify: expect="needs --force" -->

   ```bash exec
   yamlctl projects patch ledger_api parent_project=platform; echo "exit $?"
   ```

   > [!NOTE]
   > The schema marks `parent_project` immutable, since moving a project recreates it, so the change is refused until it is asked for explicitly.

3. Move it with `--force`

   <!-- verify: expect="projects/ledger_api patched" -->

   ```bash exec
   yamlctl projects patch ledger_api parent_project=platform --force
   ```

4. Delete it

   <!-- verify: expect="projects/ledger_api deleted" -->

   ```bash exec
   yamlctl projects delete ledger_api
   ```

5. Delete it again, accepting that it is gone

   <!-- verify: expect="exit 0" -->

   ```bash exec
   yamlctl projects delete ledger_api --ignore-not-found; echo "exit $?"
   ```

   > [!TIP]
   > Without `--ignore-not-found` a missing entry is a refusal, as `kubectl delete` does.

## Step 4 - Refusals

Each refusal names the problem, exits 1, and leaves the file as it was.

1. A field that does not exist

   <!-- verify: expect="no such field" -->

   ```bash exec
   yamlctl projects patch billing_api risk_profle.business_impact=HBI; echo "exit $?"
   ```

2. A value outside the allowed list

   <!-- verify: expect="must be one of" -->

   ```bash exec
   yamlctl projects patch billing_api risk_profile.business_impact=HIGH; echo "exit $?"
   ```

3. A parent that is not a folder, on a field that cannot change without `--force`

   <!-- verify: expect="must have is_folder: true" -->

   ```bash exec
   yamlctl projects patch billing_api parent_project=checkout_api; echo "exit $?"
   ```

4. A key already taken

   <!-- verify: expect="already exists" -->

   ```bash exec
   yamlctl projects create billing_api name="Billing again"; echo "exit $?"
   ```

5. An entry that is not there

   <!-- verify: expect="no entry payroll_api" -->

   ```bash exec
   yamlctl projects patch payroll_api name=Payroll; echo "exit $?"
   ```

6. An entry other entries still name

   <!-- verify: expect="still named by" -->

   ```bash exec
   yamlctl projects delete applications; echo "exit $?"
   ```

> [!TIP]
> The checks spanning entries, a reference, a condition on its target, a field that cannot change, are declared on the field with `x-yamlctl`: see `parent_project` in [the schema](:open:schemas/project.schema.json).
