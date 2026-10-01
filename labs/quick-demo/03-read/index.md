# Read

## Step 1 - Discover

1. List the resources of the directory

   <!-- verify: expect="schemas/project.schema.json" -->

   ```bash exec
   yamlctl resources
   ```

2. List the projects

   <!-- verify: expect="Checkout API" -->

   ```bash exec
   yamlctl projects list
   ```

3. Get one project

   <!-- verify: expect="business_impact: HBI" -->

   ```bash exec
   yamlctl projects get checkout_api
   ```

4. Get it by the singular

   <!-- verify: expect="business_impact: HBI" -->

   ```bash exec
   yamlctl project get checkout_api
   ```

   > [!NOTE]
   > A resource is the map, `projects:`, and the schema declares `"singular": "project"` on it, so both names reach it, as kubectl reaches `pods` as `pod`.

## Step 2 - Explain

1. List the fields a project holds

   <!-- verify: expect="<[]object>" -->

   ```bash exec
   yamlctl projects explain
   ```

2. Show the values one field allows

   <!-- verify: expect="VALUES:" -->

   ```bash exec
   yamlctl projects explain risk_profile.business_impact
   ```

   > [!TIP]
   > Everything shown is read from the schema, the way `kubectl explain` reads an API.
