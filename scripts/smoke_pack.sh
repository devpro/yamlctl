#!/usr/bin/env bash
# Packs the tarball, installs it into an empty project, and runs the command the way someone who typed `npm install yamlctl` would.
#
# `npm test` imports ../src directly and never goes near the packaged layout,
# so a missing `bin` entry, a file left out of `files`, a bin that is not executable, or a dependency missing from the manifest all pass it and fail on the first real install.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

tarball=$(cd "$here" && npm pack --pack-destination "$tmp" --silent)
cd "$tmp"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund "$tmp/$tarball" >/dev/null 2>&1

fail() { echo "smoke: $1" >&2; exit 1; }
yamlctl=./node_modules/.bin/yamlctl

# npm links this from the package's `bin`, so its absence means the manifest, not the code, is wrong.
[ -x "$yamlctl" ] || fail 'node_modules/.bin/yamlctl was not created or is not executable'

version=$("$yamlctl" --version) || fail 'yamlctl --version failed'
[ "$version" = "$(node -p "require('$here/package.json').version")" ] || fail "reported version $version does not match package.json"

# A real round trip through the installed copy: the schema read, a value typed by it, a refusal, and the file written.
mkdir -p data/schemas
cp "$here/examples/project.yaml" data/
cp "$here/examples/schemas/project.schema.json" data/schemas/
"$yamlctl" -C data project create smoke_app name="Smoke App" parent_project=applications account=005217217997 >/dev/null || fail 'create failed'
grep -q 'account: "005217217997"' data/project.yaml || fail 'the account number lost its leading zero'
if "$yamlctl" -C data project patch smoke_app risk_profile.business_impact=HIGH 2>/dev/null; then fail 'a value outside the enum was accepted'; fi
"$yamlctl" -C data check >/dev/null || fail 'check failed on a valid file'

echo "smoke: yamlctl $version installs and runs"
