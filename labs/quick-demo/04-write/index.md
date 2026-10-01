# Write

## Step 1 - Create and change

1. Create a project

   <!-- verify: expect="projects/billing_api created" -->

   ```bash exec
   yamlctl project create billing_api name="Billing API" parent_project=applications \
     account=005217217997 risk_profile.business_impact=MBI
   ```

2. Change one field of another project

   <!-- verify: expect="projects/checkout_api patched" -->

   ```bash exec
   yamlctl project patch checkout_api description="Payment processing"
   ```

3. Open [project.yaml](:open:project.yaml)

   - `account` is `"005217217997"`, a string, because the schema says string: YAML alone would read a number and drop the leading zero.
   - The comments, the order and the entries not named are as they were.

4. Run the same change again

   <!-- verify: expect="patched (no change)" -->

   ```bash exec
   yamlctl project patch checkout_api description="Payment processing"
   ```

   > [!NOTE]
   > Nothing is written when nothing changed, so a command run twice is a no-op.

## Step 2 - Refusals

Each refusal names the problem, exits 1, and leaves the file as it was.

1. A field that does not exist

   <!-- verify: expect="no such field" -->

   ```bash exec
   yamlctl project patch billing_api risk_profle.business_impact=HBI; echo "exit $?"
   ```

2. A value outside the allowed list

   <!-- verify: expect="must be one of" -->

   ```bash exec
   yamlctl project patch billing_api risk_profile.business_impact=HIGH; echo "exit $?"
   ```

3. A parent that is not a folder, on a field that cannot change without `--force`

   <!-- verify: expect="must have is_folder: true" -->

   ```bash exec
   yamlctl project patch billing_api parent_project=checkout_api; echo "exit $?"
   ```

4. A key already taken

   <!-- verify: expect="already exists" -->

   ```bash exec
   yamlctl project create billing_api name="Billing again"; echo "exit $?"
   ```

5. An entry other entries still name

   <!-- verify: expect="still named by" -->

   ```bash exec
   yamlctl project delete applications; echo "exit $?"
   ```

> [!TIP]
> The checks spanning entries, a reference, a condition on its target, a field that cannot change, are declared on the field with `x-yamlctl`: see `parent_project` in [the schema](:open:schemas/project.schema.json).
