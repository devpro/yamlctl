import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../src/cli.js';
import { cli, emptyDir, read, workspace, write } from './helpers.js';

const BIN = new URL('../bin/yamlctl.js', import.meta.url).pathname;
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

// --- the command line itself

test('options are read wherever they are written, and the words kept in order', () => {
  assert.deepEqual(parseArgs(['-C', 'data', 'project', 'get', 'x', '-o', 'json']), { options: { dir: 'data', file: null, output: 'json', from: null, force: false, offline: false, refresh: false, help: false, version: false }, words: ['project', 'get', 'x'] });
  assert.equal(parseArgs(['project', 'set', 'x', '--from=-']).options.from, '-');
  assert.equal(parseArgs(['--dir=data', 'resources']).options.dir, 'data');
  assert.deepEqual(parseArgs(['project', 'set', 'x', 'a=-1']).words, ['project', 'set', 'x', 'a=-1']);
});

test('an unknown option, a missing value and a wrong output format are usage errors', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  assert.throws(() => parseArgs(['project', 'list', '-o']), /-o needs a value/);
  assert.throws(() => parseArgs(['project', 'list', '-o', 'xml']), /-o takes yaml, json or name, not xml/);
});

test('no argument, --help and help print the usage', () => {
  for (const args of [[], ['--help'], ['-h'], ['help'], ['project', 'list', '--help']]) {
    const { code, out } = cli(workspace(), args);
    assert.equal(code, 0);
    assert.match(out, /^yamlctl reads and edits YAML data files/);
  }
});

test('--version prints the package version', () => {
  assert.deepEqual(cli(workspace(), ['--version']), { code: 0, out: `${VERSION}\n`, err: '' });
  assert.equal(cli(workspace(), ['-v']).out, `${VERSION}\n`);
});

test('a usage error exits 1 and points at the help', () => {
  const { code, err } = cli(workspace(), ['--nope']);
  assert.equal(code, 1);
  assert.equal(err, 'error: unknown option --nope\nRun yamlctl --help for the usage.\n');
});

test('a resource without a verb, and an unknown verb, are refused', () => {
  assert.match(cli(workspace(), ['project']).err, /project needs a verb: list, get, set, delete, explain or check/);
  assert.match(cli(workspace(), ['project', 'show']).err, /unknown verb show/);
});

test('the installed command runs through its shebang and exits with the status of the command', () => {
  const dir = workspace();
  const ok = spawnSync(process.execPath, [BIN, 'project', 'list'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /checkout {3}Checkout/);
  const failed = spawnSync(process.execPath, [BIN, 'project', 'get', 'none'], { cwd: dir, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, 'error: no entry none in projects\n');
});

test('set --from - reads standard input through the installed command', () => {
  const dir = workspace();
  const result = spawnSync(process.execPath, [BIN, 'project', 'set', 'billing', '--from', '-'], { cwd: dir, encoding: 'utf8', input: 'name: Billing\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(read(dir, 'project.yaml'), /billing:\n {4}name: "Billing"/);
});

// --- resources

test('resources lists every resource with its file, map, entries and schema', () => {
  const { code, out } = cli(workspace(), ['resources']);
  assert.equal(code, 0);
  assert.equal(
    out,
    [
      'RESOURCE        FILE           MAP             ENTRIES   SCHEMA',
      'ignore_rules    policy.yaml    ignore_rules    1         schemas/policy.schema.json',
      'scan_policies   policy.yaml    scan_policies   1         schemas/policy.schema.json',
      'project         project.yaml   projects        2         schemas/project.schema.json',
      'servers         servers.yml    servers         2         -',
      '',
    ].join('\n'),
  );
});

test('-C reads another directory, and paths are shown relative to where the command runs', () => {
  const parent = emptyDir();
  const dir = join(parent, 'data');
  mkdirSync(dir);
  write(dir, 'hosts.yaml', 'hosts:\n  web:\n    ip: 10.0.0.1\n');
  assert.match(cli(parent, ['-C', 'data', 'resources']).out, /\nhosts +data\/hosts\.yaml +hosts +1 +-\n/);
  assert.match(cli(parent, ['hosts', 'list', '-C', 'data']).out, /web/);
});

// --- list

test('list shows the key and the name of every entry', () => {
  assert.equal(cli(workspace(), ['project', 'list']).out, 'KEY        NAME\nplatform   Platform\ncheckout   Checkout\n');
});

test('list of a file holding several maps groups them', () => {
  assert.equal(cli(workspace(), ['policy', 'list']).out, 'ignore_rules:\n  KEY            NAME\n  dev_findings   Ignore dev findings\nscan_policies:\n  KEY           NAME\n  iac_default   IaC default\n');
});

test('list of entries with no name shows the keys alone', () => {
  const { out, err } = cli(workspace(), ['servers', 'list']);
  assert.equal(out, 'KEY\nweb\ndb\n');
  assert.equal(err, 'warning: no schema found for servers.yml, so nothing is checked\n');
});

test('list of an empty map says so', () => {
  const dir = emptyDir();
  write(dir, 'hosts.yaml', 'hosts: {}\n');
  assert.equal(cli(dir, ['hosts', 'list']).out, 'no entries\n');
});

test('list -o name prints one resource path per line', () => {
  assert.equal(cli(workspace(), ['policy', 'list', '-o', 'name']).out, 'ignore_rules/dev_findings\nscan_policies/iac_default\n');
});

test('list -o json and -o yaml print the entries as data', () => {
  const dir = workspace();
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, ['project', 'list', '-o', 'json']).out)), ['platform', 'checkout']);
  assert.match(cli(dir, ['project', 'list', '-o', 'yaml']).out, /^platform:\n {2}name: Platform\n/);
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, ['policy', 'list', '-o', 'json']).out)), ['ignore_rules', 'scan_policies']);
});

test('the field shown beside the key comes from the schema when it names one', () => {
  const dir = workspace();
  const schema = JSON.parse(read(dir, 'schemas/project.schema.json'));
  schema.properties.projects['x-yamlctl'].title = 'slug';
  write(dir, 'schemas/project.schema.json', JSON.stringify(schema));
  cli(dir, ['project', 'set', 'platform', 'slug=plat']);
  assert.match(cli(dir, ['project', 'list']).out, /^KEY {8}SLUG\nplatform {3}plat\ncheckout\n$/);
});

// --- get

test('get prints the entry alone, as YAML', () => {
  assert.equal(cli(workspace(), ['project', 'get', 'checkout']).out, 'name: Checkout\nparent_project: platform\nrisk_profile:\n  business_impact: HBI\n');
});

test('get -o json prints the entry as JSON', () => {
  assert.deepEqual(JSON.parse(cli(workspace(), ['project', 'get', 'platform', '-o', 'json']).out), { name: 'Platform', is_folder: true });
});

test('get of a missing key, or without a key, is refused', () => {
  assert.deepEqual(cli(workspace(), ['project', 'get', 'none']), { code: 1, out: '', err: 'error: no entry none in projects\n' });
  assert.match(cli(workspace(), ['project', 'get']).err, /get needs the key of an entry/);
});

test('get on a file holding several maps names the resources to use instead', () => {
  assert.match(cli(workspace(), ['policy', 'get', 'x']).err, /policy\.yaml holds several maps, use one as the resource: yamlctl ignore_rules \.\.\., yamlctl scan_policies \.\.\./);
});

test('get through a map name reaches the file holding it', () => {
  assert.equal(cli(workspace(), ['scan_policies', 'get', 'iac_default']).out, 'name: IaC default\nseverity: 3\n');
});

// --- set

test('set creates an entry, typed by the schema, and keeps the file around it', () => {
  const dir = workspace();
  const { code, out } = cli(dir, ['project', 'set', 'billing', 'name=Billing', 'parent_project=platform', 'account=005217217997', 'priority=2', 'weight=0.5', 'archived=true']);
  assert.equal(code, 0);
  assert.equal(out, 'projects/billing created\n');
  const text = read(dir, 'project.yaml');
  assert.match(text, /billing:\n {4}name: "Billing"\n {4}parent_project: "platform"\n {4}account: "005217217997"\n {4}priority: 2\n {4}weight: 0\.5\n {4}archived: true\n/);
  assert.match(text, /# kept across every edit/);
});

test('set changes the fields given and keeps the others', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['project', 'set', 'checkout', 'slug=checkout-api']).out, 'projects/checkout updated\n');
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out), { name: 'Checkout', parent_project: 'platform', risk_profile: { business_impact: 'HBI' }, slug: 'checkout-api' });
});

test('set to what the entry already holds writes nothing and says unchanged', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.equal(cli(dir, ['project', 'set', 'checkout', 'name=Checkout']).out, 'projects/checkout unchanged\n');
  assert.equal(read(dir, 'project.yaml'), before);
});

test('a path creates the objects above the field, and keeps their siblings', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'platform', 'risk_profile.business_impact=LBI']);
  cli(dir, ['project', 'set', 'checkout', 'risk_profile.regulatory_standards=["GDPR"]']);
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'platform', '-o', 'json']).out).risk_profile, { business_impact: 'LBI' });
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out).risk_profile, { business_impact: 'HBI', regulatory_standards: ['GDPR'] });
});

test('a list of objects is written as JSON', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'checkout', 'account_links=[{"account": "123", "environment": "PRODUCTION"}]']);
  assert.match(read(dir, 'project.yaml'), /account_links:\n {6}- account: "123"\n {8}environment: "PRODUCTION"/);
});

test('a map of values takes a key the schema does not list', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'checkout', 'tags.team=payments', 'labels.x-owner=ops']);
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out).tags, { team: 'payments' });
});

test('an empty value removes the field', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'checkout', 'risk_profile.business_impact=']);
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out).risk_profile, {});
});

test('a field that does not exist is refused, pointing at explain', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['project', 'set', 'checkout', 'risk_profle.business_impact=HBI']), { code: 1, out: '', err: 'error: risk_profle.business_impact: no such field in projects, run yamlctl project explain to list them\n' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('a value outside the allowed list is refused and the file left as it was', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  const { code, err } = cli(dir, ['project', 'set', 'checkout', 'risk_profile.business_impact=HIGH']);
  assert.equal(code, 1);
  assert.equal(err, 'projects/checkout.risk_profile.business_impact: must be one of "LBI", "MBI", "HBI"\nerror: projects/checkout not written\n');
  assert.equal(read(dir, 'project.yaml'), before);
});

test('a value the field type cannot hold is refused with the field named', () => {
  assert.match(cli(workspace(), ['project', 'set', 'checkout', 'priority=high']).err, /error: priority: expected integer, got high/);
  assert.match(cli(workspace(), ['project', 'set', 'checkout', 'account_links=[oops']).err, /error: account_links: expected array written as JSON, got \[oops/);
});

test('a JSON value breaking the schema inside is reported at its path', () => {
  const { code, err } = cli(workspace(), ['project', 'set', 'checkout', 'account_links=[{"environment": "DEV"}]']);
  assert.equal(code, 1);
  assert.match(err, /projects\/checkout\.account_links\.0: missing required field account/);
  assert.match(err, /projects\/checkout\.account_links\.0\.environment: must be one of "PRODUCTION", "STAGING"/);
});

test('an assignment without = and a path with an empty segment are usage errors', () => {
  assert.match(cli(workspace(), ['project', 'set', 'checkout', 'name']).err, /name is not <field>=<value>/);
  assert.match(cli(workspace(), ['project', 'set', 'checkout', 'a..b=1']).err, /a\.\.b is not a field path/);
  assert.match(cli(workspace(), ['project', 'set', 'checkout', '=1']).err, /=1 is not <field>=<value>/);
});

test('set without a key or without anything to set is refused', () => {
  assert.match(cli(workspace(), ['project', 'set']).err, /set needs the key of an entry/);
  assert.match(cli(workspace(), ['project', 'set', 'checkout']).err, /set needs at least one <field>=<value>, or --from <file>/);
});

test('set --from replaces the whole entry from a file', () => {
  const dir = workspace();
  write(dir, 'entry.yaml', 'name: Checkout v2\nparent_project: platform\n');
  assert.equal(cli(dir, ['project', 'set', 'checkout', '--from', 'entry.yaml']).out, 'projects/checkout updated\n');
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out), { name: 'Checkout v2', parent_project: 'platform' });
});

test('set --from reads JSON as well, and - reads standard input', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['project', 'set', 'billing', '--from', '-'], { stdin: '{"name": "Billing"}' }).out, 'projects/billing created\n');
});

test('get piped into set --from - copies an entry', () => {
  const dir = workspace();
  const copied = cli(dir, ['project', 'get', 'checkout']).out;
  assert.equal(cli(dir, ['project', 'set', 'checkout_copy', '--from', '-'], { stdin: copied }).out, 'projects/checkout_copy created\n');
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'checkout_copy', '-o', 'json']).out), JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out));
});

test('set --from with assignments, or with something other than one entry, is refused', () => {
  const dir = workspace();
  assert.match(cli(dir, ['project', 'set', 'x', 'name=a', '--from', '-'], { stdin: 'name: b' }).err, /set takes --from or <field>=<value>, not both/);
  assert.match(cli(dir, ['project', 'set', 'x', '--from', '-'], { stdin: '- a\n' }).err, /standard input does not hold one entry/);
  assert.match(cli(dir, ['project', 'set', 'x', '--from', '-'], { stdin: '' }).err, /standard input does not hold one entry/);
});

test('set --from checks the entry against the schema like any other set', () => {
  const dir = workspace();
  assert.match(cli(dir, ['project', 'set', 'x', '--from', '-'], { stdin: 'nme: typo\n' }).err, /projects\/x: no such field nme/);
});

test('a reference to an entry that does not exist is refused', () => {
  assert.match(cli(workspace(), ['project', 'set', 'billing', 'name=B', 'parent_project=nowhere']).err, /projects\/billing: parent_project: nowhere is not an entry of projects, set it first/);
});

test('a reference to an entry failing its target rule is refused', () => {
  assert.match(cli(workspace(), ['project', 'set', 'billing', 'name=B', 'parent_project=checkout']).err, /projects\/billing: parent_project: checkout must have is_folder: true, it has null/);
});

test('changing an immutable field needs --force, which then writes it', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'shared', 'name=Shared', 'is_folder=true']);
  const refused = cli(dir, ['project', 'set', 'checkout', 'parent_project=shared']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /parent_project: changing "platform" to "shared" needs --force, moving a project recreates it/);
  assert.equal(cli(dir, ['project', 'set', 'checkout', 'parent_project=shared', '--force']).out, 'projects/checkout updated\n');
});

test('set on a file without a schema writes values the way YAML reads them', () => {
  const dir = workspace();
  const { code, out, err } = cli(dir, ['servers', 'set', 'cache', 'port=6379', 'tags=["a"]', 'host=cache.local']);
  assert.equal(code, 0);
  assert.equal(out, 'servers/cache created\n');
  assert.match(err, /warning: no schema found for servers\.yml/);
  assert.match(read(dir, 'servers.yml'), /cache:\n {4}port: 6379\n {4}tags:\n {6}- "a"\n {4}host: "cache\.local"\n/);
});

test('set on a draft 2020-12 schema checks numbers in an enum', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['scan_policies', 'set', 'iac_default', 'severity=1']).out, 'scan_policies/iac_default updated\n');
  assert.match(cli(dir, ['scan_policies', 'set', 'iac_default', 'severity=9']).err, /severity: must be one of 1, 2, 3/);
});

test('set in a map two files could hold is refused until -f names one', () => {
  const dir = workspace();
  write(dir, 'extra.yaml', 'scan_policies:\n  other:\n    name: x\n');
  assert.match(cli(dir, ['scan_policies', 'set', 'a', 'name=A']).err, /extra\.yaml and policy\.yaml both hold a map scan_policies, name one with -f/);
  assert.equal(cli(dir, ['scan_policies', 'set', 'a', 'name=A', '-f', 'extra.yaml']).out, 'scan_policies/a created\n');
});

// --- delete

test('delete removes the entry and nothing else', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'billing', 'name=Billing']);
  assert.equal(cli(dir, ['project', 'delete', 'billing']).out, 'projects/billing deleted\n');
  assert.ok(!read(dir, 'project.yaml').includes('billing'));
  assert.match(read(dir, 'project.yaml'), /# kept across every edit/);
});

test('delete of an entry that is not there succeeds and says so, so a sync can repeat it', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['project', 'delete', 'none']), { code: 0, out: 'projects/none not found, nothing to delete\n', err: '' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('delete of an entry still named by another is refused', () => {
  assert.match(cli(workspace(), ['project', 'delete', 'platform']).err, /projects\/platform is still named by projects\/checkout: delete or change them first/);
});

test('delete without a key is refused', () => {
  assert.match(cli(workspace(), ['project', 'delete']).err, /delete needs the key of an entry/);
});

// --- explain

test('explain lists the fields of an entry with their types', () => {
  const { code, out } = cli(workspace(), ['project', 'explain']);
  assert.equal(code, 0);
  assert.match(out, /^RESOURCE: {2}projects <object>\n\nFIELDS:\n/);
  assert.match(out, /\n {2}parent_project {2}<string> {4}Key of the folder holding this project\.\n/);
  assert.match(out, /\n {2}account_links {3}<\[\]object>\n/);
  // The types line up, so every description starts in the same column.
  const columns = out
    .split('\n')
    .map((line) => line.match(/^ {2}\S+ +<[^>]+>(?: required)? +(\S.*)$/))
    .filter(Boolean)
    .map((match) => match.input.indexOf(match[1]));
  assert.ok(columns.length > 3);
  assert.equal(new Set(columns).size, 1, columns.join(','));
});

test('explain of a field shows its description, values and rules', () => {
  const out = cli(workspace(), ['project', 'explain', 'parent_project']).out;
  assert.match(out, /^FIELD: {2}parent_project <string>\n\nDESCRIPTION:\n {2}Key of the folder holding this project\.\n\nRULES:\n {2}key-of: \.\n {2}target-must: \{"is_folder":true\}\n {2}immutable: moving a project recreates it\n$/);
  assert.match(cli(workspace(), ['project', 'explain', 'risk_profile.business_impact']).out, /VALUES:\n {2}"LBI", "MBI", "HBI"\n/);
  assert.match(cli(workspace(), ['project', 'explain', 'name']).out, /DESCRIPTION:\n {2}Display name\.\n {2}Shown in the portal\.\n/);
  assert.match(cli(workspace(), ['project', 'explain', 'archived']).out, /DEFAULT: {2}false/);
});

test('explain of an object or a list of objects lists what is inside, required fields marked', () => {
  assert.match(cli(workspace(), ['project', 'explain', 'risk_profile']).out, /FIELDS:\n {2}business_impact {7}<enum> {4}One of LBI, MBI, HBI\.\n {2}regulatory_standards {2}<\[\]enum>\n/);
  assert.match(cli(workspace(), ['project', 'explain', 'account_links']).out, /FIELD: {2}account_links <\[\]object>\n\nFIELDS:\n {2}account {6}<string> required\n {2}environment {2}<enum>\n/);
});

test('explain of a field that does not exist, or of a file with no schema, is refused', () => {
  assert.match(cli(workspace(), ['project', 'explain', 'nope']).err, /projects has no field nope/);
  assert.match(cli(workspace(), ['servers', 'explain']).err, /servers\.yml has no schema to explain/);
});

// --- check

test('check of a valid file reports its entries', () => {
  assert.deepEqual(cli(workspace(), ['project', 'check']), { code: 0, out: 'project.yaml: 2 entries, valid\n', err: '' });
});

test('check of a file edited by hand reports every problem and exits 1', () => {
  const dir = workspace();
  write(dir, 'project.yaml', `${read(dir, 'project.yaml')}  typo:\n    nme: x\n  orphan:\n    parent_project: gone\n`);
  const { code, err } = cli(dir, ['project', 'check']);
  assert.equal(code, 1);
  assert.match(err, /project\.yaml\.projects\.typo: no such field nme/);
  assert.match(err, /project\.yaml: projects\/orphan: parent_project: gone is not an entry of projects, set it first/);
});

test('check of a file missing a required top-level map fails', () => {
  const dir = workspace();
  write(dir, 'project.yaml', '# yaml-language-server: $schema=schemas/project.schema.json\nprojects_defaults: {}\n');
  assert.match(cli(dir, ['project', 'check']).err, /project\.yaml: missing required field projects/);
});

test('check with no resource checks every file, and fails if any does', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['check']), { code: 0, out: 'policy.yaml: 2 entries, valid\nproject.yaml: 2 entries, valid\nservers.yml: no schema, not checked\n', err: '' });
  write(dir, 'broken.yaml', 'a: [\n');
  const failed = cli(dir, ['check']);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /broken\.yaml: .*not valid YAML/);
});

test('check of a file naming a missing schema fails rather than passing unchecked', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', '# yaml-language-server: $schema=schemas/none.json\nitems: {}\n');
  const { code, err } = cli(dir, ['check']);
  assert.equal(code, 1);
  assert.match(err, /^a\.yaml names .*none\.json, which does not exist\n$/);
});

test('check -f checks that one file', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['check', '-f', 'policy.yaml']).out, 'policy.yaml: 2 entries, valid\n');
});

// Checking nothing where the file asked for a check is worse than stopping, so a write refuses and a read only warns.
test('a file naming a schema that cannot be loaded is read with a warning and never written', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', '# yaml-language-server: $schema=schemas/none.json\nitems:\n  one:\n    n: 1\n');
  const before = read(dir, 'a.yaml');
  const refused = cli(dir, ['a', 'set', 'x', 'n=1']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^error: .*a\.yaml names .*none\.json, which does not exist, so it is not written\n$/);
  assert.equal(cli(dir, ['a', 'delete', 'one']).code, 1);
  assert.equal(read(dir, 'a.yaml'), before);
  const listed = cli(dir, ['a', 'list']);
  assert.equal(listed.code, 0);
  assert.match(listed.err, /^warning: .*none\.json, which does not exist, so nothing is checked\n$/);
});

test('a schema with a scheme other than file or http(s) is refused for a write', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', '# yaml-language-server: $schema=ftp://example.com/s.json\nitems: {}\n');
  assert.match(cli(dir, ['a', 'set', 'x', 'n=1']).err, /names ftp:\/\/example\.com\/s\.json, and only file and http\(s\) schemas are read, so it is not written/);
});

test('a directory with no data file has no resources and nothing to check', () => {
  const dir = emptyDir();
  assert.equal(cli(dir, ['resources']).out, 'RESOURCE   FILE   MAP   ENTRIES   SCHEMA\n');
  assert.deepEqual(cli(dir, ['check']), { code: 0, out: '', err: '' });
  assert.match(cli(dir, ['project', 'list']).err, /no resource project in .*which holds no YAML data file/);
});

// --- what a pipeline will send sooner or later

test('a value containing = keeps everything after the first one', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'checkout', 'slug=a=b=c']);
  assert.equal(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out).slug, 'a=b=c');
});

test('a key holding dots, dashes or slashes is taken as one key', () => {
  const dir = workspace();
  for (const key of ['app.v2', 'app-v2', 'team/app']) {
    assert.equal(cli(dir, ['project', 'set', key, 'name=X']).out, `projects/${key} created\n`);
    assert.equal(cli(dir, ['project', 'get', key]).out, 'name: X\n');
  }
});

test('unicode and quotes survive the round trip', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'checkout', 'name=Caisse « rapide » "v2" ✓']);
  assert.equal(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out).name, 'Caisse « rapide » "v2" ✓');
  assert.equal(cli(dir, ['project', 'check']).code, 0);
});

test('null sets a nullable field to null, which is different from removing it', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'checkout', 'priority=null']);
  assert.deepEqual(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out).priority, null);
  assert.match(read(dir, 'project.yaml'), /priority: null/);
});

test('a string field takes the text null as it is', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'checkout', 'slug=null']);
  assert.equal(JSON.parse(cli(dir, ['project', 'get', 'checkout', '-o', 'json']).out).slug, 'null');
});

test('each item of a list of allowed values is checked', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['project', 'set', 'checkout', 'risk_profile.regulatory_standards=["GDPR","SOC"]']).code, 0);
  assert.match(cli(dir, ['project', 'set', 'checkout', 'risk_profile.regulatory_standards=["GDPR","HIPAA"]']).err, /regulatory_standards\.1: must be one of "ISO_27001", "SOC", "GDPR"/);
});

test('explain shows the allowed values of a list of them', () => {
  assert.match(cli(workspace(), ['project', 'explain', 'risk_profile.regulatory_standards']).out, /^FIELD: {2}risk_profile\.regulatory_standards <\[\]enum>\n\nVALUES:\n {2}"ISO_27001", "SOC", "GDPR"\n$/);
});

test('get -o yaml is the default format', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['project', 'get', 'checkout', '-o', 'yaml']).out, cli(dir, ['project', 'get', 'checkout']).out);
});

test('several fields set in one command are checked and written together', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  const { code } = cli(dir, ['project', 'set', 'checkout', 'slug=ok', 'priority=many']);
  assert.equal(code, 1);
  assert.equal(read(dir, 'project.yaml'), before, 'the valid field is not written when another fails');
});

test('a file written by yamlctl reads back unchanged by the next command', () => {
  const dir = workspace();
  cli(dir, ['project', 'set', 'billing', 'name=Billing', 'account_links=[{"account": "1"}]', 'tags={"team": "a"}']);
  const written = read(dir, 'project.yaml');
  assert.equal(cli(dir, ['project', 'set', 'billing', 'name=Billing']).out, 'projects/billing unchanged\n');
  assert.equal(read(dir, 'project.yaml'), written);
  assert.equal(cli(dir, ['check']).code, 0);
});

test('an entry left empty in the file is listed and can be filled', () => {
  const dir = workspace();
  write(dir, 'project.yaml', `${read(dir, 'project.yaml')}  placeholder:\n`);
  assert.match(cli(dir, ['project', 'list']).out, /placeholder/);
  assert.equal(cli(dir, ['project', 'set', 'placeholder', 'name=Filled']).out, 'projects/placeholder updated\n');
});

test('-f reaches a file outside the directory, with its schema found beside it', () => {
  const dir = workspace();
  const other = emptyDir();
  write(other, 'project.yaml', `# yaml-language-server: $schema=${join(dir, 'schemas', 'project.schema.json')}\nprojects: {}\n`);
  assert.equal(cli(dir, ['project', 'set', 'x', 'name=X', '-f', join(other, 'project.yaml')]).out, 'projects/x created\n');
  assert.match(cli(dir, ['project', 'set', 'x', 'nme=X', '-f', join(other, 'project.yaml')]).err, /no such field in projects/);
});

test('explain goes into the items of a list of objects', () => {
  assert.match(cli(workspace(), ['project', 'explain', 'account_links.environment']).out, /^FIELD: {2}account_links\.environment <enum>\n\nVALUES:\n {2}"PRODUCTION", "STAGING"\n$/);
});

test('set through a list says the list is set whole, rather than that the field does not exist', () => {
  const { code, err } = cli(workspace(), ['project', 'set', 'checkout', 'account_links.account=1']);
  assert.equal(code, 1);
  assert.equal(err, `error: account_links.account: goes into a list, which is set whole as JSON: account_links='[...]'\n`);
});
