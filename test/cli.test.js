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
  assert.deepEqual(parseArgs(['-C', 'data', 'projects', 'get', 'x', '-o', 'json']), { options: { dir: 'data', dataFile: null, output: 'json', filename: null, force: false, ignoreNotFound: false, prune: false, all: false, prefix: null, offline: false, refresh: false, help: false, version: false }, words: ['projects', 'get', 'x'] });
  assert.equal(parseArgs(['projects', 'apply', 'x', '--filename=-']).options.filename, '-');
  assert.equal(parseArgs(['projects', 'delete', 'x', '--ignore-not-found']).options.ignoreNotFound, true);
  assert.deepEqual(parseArgs(['projects', 'apply', '-f', 'a.yaml', '--prune', '--prefix=app_']).options.prefix, 'app_');
  assert.equal(parseArgs(['--dir=data', 'resources']).options.dir, 'data');
  assert.deepEqual(parseArgs(['projects', 'apply', 'x', 'a=-1']).words, ['projects', 'apply', 'x', 'a=-1']);
});

test('an unknown option, a missing value and a wrong output format are usage errors', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option --nope/);
  assert.throws(() => parseArgs(['projects', 'apply', 'x', '--from', '-']), /unknown option --from/);
  assert.throws(() => parseArgs(['projects', 'list', '--file', 'a.yaml']), /unknown option --file/);
  assert.throws(() => parseArgs(['projects', 'list', '-o']), /-o needs a value/);
  assert.throws(() => parseArgs(['projects', 'list', '-o', 'xml']), /-o takes yaml, json or name, not xml/);
});

test('no argument, --help and help print the usage', () => {
  for (const args of [[], ['--help'], ['-h'], ['help'], ['projects', 'list', '--help']]) {
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
  assert.match(cli(workspace(), ['projects']).err, /projects needs a verb: list, get, create, apply, patch, replace, delete, explain or check/);
  assert.match(cli(workspace(), ['projects', 'show']).err, /unknown verb show/);
});

test('the installed command runs through its shebang and exits with the status of the command', () => {
  const dir = workspace();
  const ok = spawnSync(process.execPath, [BIN, 'projects', 'list'], { cwd: dir, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /checkout {3}Checkout/);
  const failed = spawnSync(process.execPath, [BIN, 'projects', 'get', 'none'], { cwd: dir, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, 'error: no entry none in projects\n');
});

test('apply -f - reads standard input through the installed command', () => {
  const dir = workspace();
  const result = spawnSync(process.execPath, [BIN, 'projects', 'apply', '-f', '-'], { cwd: dir, encoding: 'utf8', input: 'billing:\n  name: Billing\n' });
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
      'RESOURCE        FILE           ENTRIES   SCHEMA',
      'ignore_rules    policy.yaml    1         schemas/policy.schema.json',
      'scan_policies   policy.yaml    1         schemas/policy.schema.json',
      'projects        project.yaml   2         schemas/project.schema.json',
      'servers         servers.yml    2         -',
      '',
    ].join('\n'),
  );
});

test('-C reads another directory, and paths are shown relative to where the command runs', () => {
  const parent = emptyDir();
  const dir = join(parent, 'data');
  mkdirSync(dir);
  write(dir, 'hosts.yaml', 'hosts:\n  web:\n    ip: 10.0.0.1\n');
  assert.match(cli(parent, ['-C', 'data', 'resources']).out, /\nhosts +data\/hosts\.yaml +1 +-\n/);
  assert.match(cli(parent, ['hosts', 'list', '-C', 'data']).out, /web/);
});

test('resources -o json and -o name print the resources as data', () => {
  const resources = JSON.parse(cli(workspace(), ['resources', '-o', 'json']).out);
  assert.deepEqual(resources.find((r) => r.name === 'projects'), { name: 'projects', singular: 'project', file: 'project.yaml', entries: 2, schema: 'schemas/project.schema.json' });
  assert.deepEqual(resources.find((r) => r.name === 'servers'), { name: 'servers', singular: null, file: 'servers.yml', entries: 2, schema: null });
  assert.equal(cli(workspace(), ['resources', '-o', 'name']).out, 'ignore_rules\nscan_policies\nprojects\nservers\n');
});

// --- list

test('list shows the key and the name of every entry', () => {
  assert.equal(cli(workspace(), ['projects', 'list']).out, 'KEY        NAME\nplatform   Platform\ncheckout   Checkout\n');
});

test('the singular reads and writes the same map, and what is printed names the plural', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['project', 'list']).out, cli(dir, ['projects', 'list']).out);
  assert.equal(cli(dir, ['project', 'apply', 'billing', 'name=Billing']).out, 'projects/billing created\n');
  assert.equal(cli(dir, ['project', 'get', 'billing', '-o', 'name']).out, 'projects/billing\n');
});

test('list of a map in a file holding several shows that map alone', () => {
  assert.equal(cli(workspace(), ['scan_policies', 'list']).out, 'KEY           NAME\niac_default   IaC default\n');
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
  assert.equal(cli(workspace(), ['projects', 'list', '-o', 'name']).out, 'projects/platform\nprojects/checkout\n');
});

test('list -o json and -o yaml print the entries as data', () => {
  const dir = workspace();
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, ['projects', 'list', '-o', 'json']).out)), ['platform', 'checkout']);
  assert.match(cli(dir, ['projects', 'list', '-o', 'yaml']).out, /^platform:\n {2}name: Platform\n/);
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, ['scan_policies', 'list', '-o', 'json']).out)), ['iac_default']);
});

test('the field shown beside the key comes from the schema when it names one', () => {
  const dir = workspace();
  const schema = JSON.parse(read(dir, 'schemas/project.schema.json'));
  schema.properties.projects['x-yamlctl'].title = 'slug';
  write(dir, 'schemas/project.schema.json', JSON.stringify(schema));
  cli(dir, ['projects', 'apply', 'platform', 'slug=plat']);
  assert.match(cli(dir, ['projects', 'list']).out, /^KEY {8}SLUG\nplatform {3}plat\ncheckout\n$/);
});

// --- get

test('get prints the entry under its key, as YAML, the shape -f reads', () => {
  assert.equal(cli(workspace(), ['projects', 'get', 'checkout']).out, 'checkout:\n  name: Checkout\n  parent_project: platform\n  risk_profile:\n    business_impact: HBI\n');
});

test('get -o json prints the entry under its key as JSON', () => {
  assert.deepEqual(JSON.parse(cli(workspace(), ['projects', 'get', 'platform', '-o', 'json']).out), { platform: { name: 'Platform', is_folder: true } });
});

test('get -o name prints the resource path of each entry', () => {
  assert.equal(cli(workspace(), ['projects', 'get', 'checkout', 'platform', '-o', 'name']).out, 'projects/checkout\nprojects/platform\n');
});

test('get of several keys prints them in the order asked', () => {
  assert.deepEqual(Object.keys(JSON.parse(cli(workspace(), ['projects', 'get', 'checkout', 'platform', '-o', 'json']).out)), ['checkout', 'platform']);
});

test('get of a missing key, or without a key, is refused', () => {
  assert.deepEqual(cli(workspace(), ['projects', 'get', 'none']), { code: 1, out: '', err: 'error: no entry none in projects\n' });
  assert.deepEqual(cli(workspace(), ['projects', 'get', 'checkout', 'none']), { code: 1, out: '', err: 'error: no entry none in projects\n' });
  assert.match(cli(workspace(), ['projects', 'get']).err, /get needs the key of an entry/);
});

test('a file name is refused, naming the resources it holds', () => {
  assert.match(cli(workspace(), ['policy', 'get', 'x']).err, /policy\.yaml is a file rather than a resource, use yamlctl ignore_rules \.\.\., yamlctl scan_policies \.\.\./);
});

test('get through a map name reaches the file holding it', () => {
  assert.equal(cli(workspace(), ['scan_policies', 'get', 'iac_default']).out, 'iac_default:\n  name: IaC default\n  severity: 3\n');
});

// --- apply

test('apply creates an entry, typed by the schema, and keeps the file around it', () => {
  const dir = workspace();
  const { code, out } = cli(dir, ['projects', 'apply', 'billing', 'name=Billing', 'parent_project=platform', 'account=005217217997', 'priority=2', 'weight=0.5', 'archived=true']);
  assert.equal(code, 0);
  assert.equal(out, 'projects/billing created\n');
  const text = read(dir, 'project.yaml');
  assert.match(text, /billing:\n {4}name: "Billing"\n {4}parent_project: "platform"\n {4}account: "005217217997"\n {4}priority: 2\n {4}weight: 0\.5\n {4}archived: true\n/);
  assert.match(text, /# kept across every edit/);
});

test('apply changes the fields given and keeps the others', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['projects', 'apply', 'checkout', 'slug=checkout-api']).out, 'projects/checkout configured\n');
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout, { name: 'Checkout', parent_project: 'platform', risk_profile: { business_impact: 'HBI' }, slug: 'checkout-api' });
});

test('apply to what the entry already holds writes nothing and says unchanged', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.equal(cli(dir, ['projects', 'apply', 'checkout', 'name=Checkout']).out, 'projects/checkout unchanged\n');
  assert.equal(read(dir, 'project.yaml'), before);
});

test('a path creates the objects above the field, and keeps their siblings', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'platform', 'risk_profile.business_impact=LBI']);
  cli(dir, ['projects', 'apply', 'checkout', 'risk_profile.regulatory_standards=["GDPR"]']);
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'platform', '-o', 'json']).out).platform.risk_profile, { business_impact: 'LBI' });
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout.risk_profile, { business_impact: 'HBI', regulatory_standards: ['GDPR'] });
});

test('a list of objects is written as JSON', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'checkout', 'account_links=[{"account": "123", "environment": "PRODUCTION"}]']);
  assert.match(read(dir, 'project.yaml'), /account_links:\n {6}- account: "123"\n {8}environment: "PRODUCTION"/);
});

test('a map of values takes a key the schema does not list', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'checkout', 'tags.team=payments', 'labels.x-owner=ops']);
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout.tags, { team: 'payments' });
});

test('an empty value removes the field', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'checkout', 'risk_profile.business_impact=']);
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout.risk_profile, {});
});

test('a field that does not exist is refused, pointing at explain', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['projects', 'apply', 'checkout', 'risk_profle.business_impact=HBI']), { code: 1, out: '', err: 'error: risk_profle.business_impact: no such field in projects, run yamlctl projects explain to list them\n' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('a value outside the allowed list is refused and the file left as it was', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  const { code, err } = cli(dir, ['projects', 'apply', 'checkout', 'risk_profile.business_impact=HIGH']);
  assert.equal(code, 1);
  assert.equal(err, 'projects/checkout.risk_profile.business_impact: must be one of "LBI", "MBI", "HBI"\nerror: projects/checkout not written\n');
  assert.equal(read(dir, 'project.yaml'), before);
});

test('a value the field type cannot hold is refused with the field named', () => {
  assert.match(cli(workspace(), ['projects', 'apply', 'checkout', 'priority=high']).err, /error: priority: expected integer, got high/);
  assert.match(cli(workspace(), ['projects', 'apply', 'checkout', 'account_links=[oops']).err, /error: account_links: expected array written as JSON, got \[oops/);
});

test('a JSON value breaking the schema inside is reported at its path', () => {
  const { code, err } = cli(workspace(), ['projects', 'apply', 'checkout', 'account_links=[{"environment": "DEV"}]']);
  assert.equal(code, 1);
  assert.match(err, /projects\/checkout\.account_links\.0: missing required field account/);
  assert.match(err, /projects\/checkout\.account_links\.0\.environment: must be one of "PRODUCTION", "STAGING"/);
});

test('an assignment without = and a path with an empty segment are usage errors', () => {
  assert.match(cli(workspace(), ['projects', 'apply', 'checkout', 'name']).err, /name is not <field>=<value>/);
  assert.match(cli(workspace(), ['projects', 'apply', 'checkout', 'a..b=1']).err, /a\.\.b is not a field path/);
  assert.match(cli(workspace(), ['projects', 'apply', 'checkout', '=1']).err, /=1 is not <field>=<value>/);
});

test('apply without a key or without anything to write is refused', () => {
  assert.match(cli(workspace(), ['projects', 'apply']).err, /apply needs the key of an entry, or -f <file>/);
  assert.match(cli(workspace(), ['projects', 'apply', 'checkout']).err, /apply needs at least one <field>=<value>, or -f <file>/);
});

// --- -f, a file of entries by key, the shape get and list -o yaml print

test('apply -f creates, configures or leaves each entry of the file, and writes once', () => {
  const dir = workspace();
  write(dir, 'entries.yaml', 'billing:\n  name: Billing\ncheckout:\n  slug: checkout-api\nplatform:\n  name: Platform\n');
  assert.deepEqual(cli(dir, ['projects', 'apply', '-f', 'entries.yaml']), { code: 0, out: 'projects/billing created\nprojects/checkout configured\nprojects/platform unchanged\n', err: '' });
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'billing', 'checkout', '-o', 'json']).out), { billing: { name: 'Billing' }, checkout: { name: 'Checkout', parent_project: 'platform', risk_profile: { business_impact: 'HBI' }, slug: 'checkout-api' } });
});

test('apply -f merges objects, replaces lists and removes a field set to null, the way a merge patch does', () => {
  const dir = workspace();
  cli(dir, ['projects', 'patch', 'checkout', 'risk_profile.regulatory_standards=["GDPR"]', 'slug=old']);
  const { code, out } = cli(dir, ['projects', 'apply', '-f', '-'], { stdin: '{"checkout": {"risk_profile": {"regulatory_standards": ["SOC"]}, "slug": null}}' });
  assert.equal(code, 0);
  assert.equal(out, 'projects/checkout configured\n');
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout, { name: 'Checkout', parent_project: 'platform', risk_profile: { business_impact: 'HBI', regulatory_standards: ['SOC'] } });
});

test('list -o yaml read back through apply -f changes nothing', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  const listed = cli(dir, ['projects', 'list', '-o', 'yaml']).out;
  assert.deepEqual(cli(dir, ['projects', 'apply', '-f', '-'], { stdin: listed }), { code: 0, out: 'projects/platform unchanged\nprojects/checkout unchanged\n', err: '' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('an entry of the file may name another entry of the same file', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['projects', 'create', '-f', '-'], { stdin: 'apps:\n  name: Apps\n  is_folder: true\nbilling:\n  name: Billing\n  parent_project: apps\n' }), { code: 0, out: 'projects/apps created\nprojects/billing created\n', err: '' });
});

test('one entry of the file failing its check leaves the whole file unwritten', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  const { code, out, err } = cli(dir, ['projects', 'apply', '-f', '-'], { stdin: 'billing:\n  name: Billing\nledger:\n  nme: typo\n' });
  assert.equal(code, 1);
  assert.equal(out, '');
  assert.match(err, /^projects\/ledger: no such field nme/);
  assert.match(err, /\nerror: project\.yaml not written\n$/);
  assert.equal(read(dir, 'project.yaml'), before);
});

test('-f needs entries by key, each one an object', () => {
  const dir = workspace();
  assert.match(cli(dir, ['projects', 'apply', '-f', '-'], { stdin: '- a\n' }).err, /^error: standard input does not hold entries by key\n/);
  assert.match(cli(dir, ['projects', 'apply', '-f', '-'], { stdin: '' }).err, /^error: standard input holds no entries\n/);
  assert.match(cli(dir, ['projects', 'apply', '-f', '-'], { stdin: '{}' }).err, /^error: standard input holds no entries\n/);
  assert.match(cli(dir, ['projects', 'apply', '-f', '-'], { stdin: 'billing: Billing\n' }).err, /^error: standard input: billing is not an entry\n/);
  assert.match(cli(dir, ['projects', 'apply', '-f', 'none.yaml']).err, /^error: cannot read none\.yaml/);
});

// --- apply --prune

// A sync owns the entries under its prefix: what the source no longer holds goes, and everything else stays.
test('apply --prune --prefix deletes the entries under the prefix that the file does not hold', () => {
  const dir = workspace();
  cli(dir, ['projects', 'create', '-f', '-'], { stdin: 'app_1:\n  name: One\napp_2:\n  name: Two\n' });
  const { code, out, err } = cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--prefix', 'app_'], { stdin: 'app_2:\n  name: Two\napp_3:\n  name: Three\n' });
  assert.deepEqual({ code, out, err }, { code: 0, out: 'projects/app_2 unchanged\nprojects/app_3 created\nprojects/app_1 pruned\n', err: '' });
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, ['projects', 'list', '-o', 'json']).out)), ['platform', 'checkout', 'app_2', 'app_3']);
});

test('apply --prune run again changes nothing', () => {
  const dir = workspace();
  const entries = 'app_1:\n  name: One\n';
  cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--prefix', 'app_'], { stdin: entries });
  const before = read(dir, 'project.yaml');
  assert.equal(cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--prefix', 'app_'], { stdin: entries }).out, 'projects/app_1 unchanged\n');
  assert.equal(read(dir, 'project.yaml'), before);
});

test('apply --prune --all deletes every entry the file does not hold', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--all'], { stdin: 'solo:\n  name: Solo\n' }), { code: 0, out: 'projects/solo created\nprojects/platform pruned\nprojects/checkout pruned\n', err: '' });
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, ['projects', 'list', '-o', 'json']).out)), ['solo']);
});

test('apply --prune refuses an entry of the file outside the prefix', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--prefix', 'app_'], { stdin: 'app_1:\n  name: One\nbilling:\n  name: Billing\n' }), { code: 1, out: '', err: 'error: standard input holds billing, outside the prefix app_ it prunes\n' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('apply --prune refuses to prune an entry another entry still names, and writes nothing', () => {
  const dir = workspace();
  cli(dir, ['projects', 'create', '-f', '-'], { stdin: 'app_folder:\n  name: Folder\n  is_folder: true\napp_child:\n  name: Child\n  parent_project: app_folder\n' });
  cli(dir, ['projects', 'patch', 'checkout', 'parent_project=app_folder', '--force']);
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--prefix', 'app_'], { stdin: 'app_new:\n  name: New\n' }), { code: 1, out: '', err: 'error: projects/app_folder is still named by projects/checkout: delete or change them first\n' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('apply --prune refuses an entry of the file naming one it prunes', () => {
  const dir = workspace();
  cli(dir, ['projects', 'create', 'app_folder', 'name=Folder', 'is_folder=true']);
  const { code, err } = cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--prefix', 'app_'], { stdin: 'app_child:\n  name: Child\n  parent_project: app_folder\n' });
  assert.equal(code, 1);
  assert.equal(err, 'projects/app_child: parent_project: app_folder is not an entry of projects, create it first\nerror: project.yaml not written\n');
});

test('--prune needs apply -f and a scope, and a scope needs --prune', () => {
  const usage = (args, message) => assert.match(cli(workspace(), ['projects', ...args], { stdin: 'app_1: {}\n' }).err, new RegExp(`^error: ${message}\n`));
  usage(['apply', '-f', '-', '--prune'], '--prune needs --prefix <prefix> or --all, the entries it may delete');
  usage(['apply', 'app_1', 'name=X', '--prune', '--all'], '--prune works with apply -f only');
  usage(['create', '-f', '-', '--prune', '--all'], '--prune works with apply -f only');
  usage(['apply', '-f', '-', '--all'], '--prefix and --all work with --prune only');
  usage(['apply', '-f', '-', '--prune', '--all', '--prefix', 'app_'], '--prune takes --prefix <prefix> or --all, not both');
  usage(['apply', '-f', '-', '--prune', '--prefix', ''], '--prefix needs a prefix, --all prunes every entry');
});

// --- -o on the verbs writing entries, so a pipeline reads what was done rather than a sentence

test('-o name prints the resource path of each entry written', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['projects', 'create', 'billing', 'name=Billing', '-o', 'name']), { code: 0, out: 'projects/billing\n', err: '' });
  assert.equal(cli(dir, ['projects', 'apply', '-f', '-', '-o', 'name'], { stdin: 'billing:\n  name: Billing\nledger:\n  name: Ledger\n' }).out, 'projects/billing\nprojects/ledger\n');
  assert.equal(cli(dir, ['projects', 'patch', 'ledger', 'slug=l', '-o', 'name']).out, 'projects/ledger\n');
  assert.equal(cli(dir, ['projects', 'delete', 'billing', 'ledger', '-o', 'name']).out, 'projects/billing\nprojects/ledger\n');
});

test('-o name after apply --prune names the entries pruned as well', () => {
  const dir = workspace();
  cli(dir, ['projects', 'create', 'app_1', 'name=One']);
  assert.equal(cli(dir, ['projects', 'apply', '-f', '-', '--prune', '--prefix', 'app_', '-o', 'name'], { stdin: 'app_2:\n  name: Two\n' }).out, 'projects/app_2\nprojects/app_1\n');
});

test('-o json and -o yaml print the entries as written, under their keys', () => {
  const dir = workspace();
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'apply', '-f', '-', '-o', 'json'], { stdin: 'checkout:\n  slug: c\nbilling:\n  name: Billing\n' }).out), {
    checkout: { name: 'Checkout', parent_project: 'platform', risk_profile: { business_impact: 'HBI' }, slug: 'c' },
    billing: { name: 'Billing' },
  });
  assert.equal(cli(dir, ['projects', 'patch', 'billing', 'priority=2', '-o', 'yaml']).out, 'billing:\n  name: Billing\n  priority: 2\n');
  assert.equal(cli(dir, ['projects', 'replace', '-f', '-', '-o', 'yaml'], { stdin: 'billing:\n  name: B\n' }).out, 'billing:\n  name: B\n');
});

test('-o is refused where it has nothing to print', () => {
  assert.match(cli(workspace(), ['projects', 'delete', 'checkout', '-o', 'json']).err, /^error: delete takes -o name only\n/);
  assert.match(cli(workspace(), ['projects', 'explain', '-o', 'json']).err, /^error: explain takes no -o\n/);
  assert.match(cli(workspace(), ['check', '-o', 'json']).err, /^error: check takes no -o, its exit status is the result\n/);
  assert.match(cli(workspace(), ['projects', 'check', '-o', 'name']).err, /^error: check takes no -o, its exit status is the result\n/);
});

test('-f and a key together are a usage error', () => {
  for (const verb of ['create', 'apply', 'delete']) {
    assert.match(cli(workspace(), ['projects', verb, 'x', '-f', '-'], { stdin: 'x: {}\n' }).err, new RegExp(`^error: ${verb} takes -f <file> without a key\n`));
  }
});

test('a reference to an entry that does not exist is refused', () => {
  assert.match(cli(workspace(), ['projects', 'apply', 'billing', 'name=B', 'parent_project=nowhere']).err, /projects\/billing: parent_project: nowhere is not an entry of projects, create it first/);
});

test('a reference to an entry failing its target rule is refused', () => {
  assert.match(cli(workspace(), ['projects', 'apply', 'billing', 'name=B', 'parent_project=checkout']).err, /projects\/billing: parent_project: checkout must have is_folder: true, it has null/);
});

test('changing an immutable field needs --force, which then writes it', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'shared', 'name=Shared', 'is_folder=true']);
  const refused = cli(dir, ['projects', 'apply', 'checkout', 'parent_project=shared']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /parent_project: changing "platform" to "shared" needs --force, moving a project recreates it/);
  assert.equal(cli(dir, ['projects', 'apply', 'checkout', 'parent_project=shared', '--force']).out, 'projects/checkout configured\n');
});

test('apply on a file without a schema writes values the way YAML reads them', () => {
  const dir = workspace();
  const { code, out, err } = cli(dir, ['servers', 'apply', 'cache', 'port=6379', 'tags=["a"]', 'host=cache.local']);
  assert.equal(code, 0);
  assert.equal(out, 'servers/cache created\n');
  assert.match(err, /warning: no schema found for servers\.yml/);
  assert.match(read(dir, 'servers.yml'), /cache:\n {4}port: 6379\n {4}tags:\n {6}- "a"\n {4}host: "cache\.local"\n/);
});

test('apply on a draft 2020-12 schema checks numbers in an enum', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['scan_policies', 'apply', 'iac_default', 'severity=1']).out, 'scan_policies/iac_default configured\n');
  assert.match(cli(dir, ['scan_policies', 'apply', 'iac_default', 'severity=9']).err, /severity: must be one of 1, 2, 3/);
});

test('apply in a map two files could hold is refused until --data-file names one', () => {
  const dir = workspace();
  write(dir, 'extra.yaml', 'scan_policies:\n  other:\n    name: x\n');
  assert.match(cli(dir, ['scan_policies', 'apply', 'a', 'name=A']).err, /extra\.yaml and policy\.yaml both hold a map scan_policies, name one with --data-file/);
  assert.equal(cli(dir, ['scan_policies', 'apply', 'a', 'name=A', '--data-file', 'extra.yaml']).out, 'scan_policies/a created\n');
});

// --- create

test('create adds an entry from fields', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['projects', 'create', 'billing', 'name=Billing', 'priority=2']), { code: 0, out: 'projects/billing created\n', err: '' });
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'billing', '-o', 'json']).out).billing, { name: 'Billing', priority: 2 });
});

test('create of an entry already there is refused and the file left as it was', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['projects', 'create', 'checkout', 'name=Other']), { code: 1, out: '', err: 'error: projects/checkout already exists, use apply, patch or replace to change it\n' });
  assert.deepEqual(cli(dir, ['projects', 'create', '-f', '-'], { stdin: 'billing:\n  name: Billing\ncheckout:\n  name: Other\n' }), { code: 1, out: '', err: 'error: projects/checkout already exists, use apply, patch or replace to change it\n' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('create checks the entry against the schema like any other write', () => {
  assert.match(cli(workspace(), ['projects', 'create', 'billing', 'name=B', 'parent_project=nowhere']).err, /projects\/billing: parent_project: nowhere is not an entry of projects, create it first/);
});

test('create without a key or without anything to write is refused', () => {
  assert.match(cli(workspace(), ['projects', 'create']).err, /create needs the key of an entry, or -f <file>/);
  assert.match(cli(workspace(), ['projects', 'create', 'billing']).err, /create needs at least one <field>=<value>, or -f <file>/);
});

// --- patch

test('patch changes the fields given and keeps the others', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['projects', 'patch', 'checkout', 'slug=checkout-api']), { code: 0, out: 'projects/checkout patched\n', err: '' });
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout, { name: 'Checkout', parent_project: 'platform', risk_profile: { business_impact: 'HBI' }, slug: 'checkout-api' });
});

test('patch keeps the comments inside the entry', () => {
  const dir = workspace();
  cli(dir, ['projects', 'patch', 'checkout', 'name=Checkout v2']);
  assert.match(read(dir, 'project.yaml'), / {2}checkout:\n {4}name: "Checkout v2"\n {4}# kept across every edit\n {4}parent_project: "platform"\n/);
});

test('patch to what the entry already holds writes nothing and says no change', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.equal(cli(dir, ['projects', 'patch', 'checkout', 'name=Checkout']).out, 'projects/checkout patched (no change)\n');
  assert.equal(read(dir, 'project.yaml'), before);
});

test('patch of an entry that is not there is refused', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['projects', 'patch', 'none', 'name=None']), { code: 1, out: '', err: 'error: no entry none in projects\n' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('patch takes a key and fields only, and needs at least one field', () => {
  assert.match(cli(workspace(), ['projects', 'patch', 'checkout', '-f', '-'], { stdin: 'checkout: {}\n' }).err, /patch takes <key> <field>=<value>\.\.\., replace takes -f <file>/);
  assert.match(cli(workspace(), ['projects', 'patch']).err, /patch needs the key of an entry/);
  assert.match(cli(workspace(), ['projects', 'patch', 'checkout']).err, /patch needs at least one <field>=<value>/);
});

// --- replace

test('replace swaps each entry of the file whole', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['projects', 'replace', '-f', '-'], { stdin: 'checkout:\n  name: Checkout v2\n  parent_project: platform\n' }), { code: 0, out: 'projects/checkout replaced\n', err: '' });
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout, { name: 'Checkout v2', parent_project: 'platform' });
});

test('get read back through replace -f changes nothing', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  const same = cli(dir, ['projects', 'get', 'checkout']).out;
  assert.equal(cli(dir, ['projects', 'replace', '-f', '-'], { stdin: same }).out, 'projects/checkout replaced (no change)\n');
  assert.equal(read(dir, 'project.yaml'), before);
});

test('replace of an entry that is not there is refused', () => {
  assert.deepEqual(cli(workspace(), ['projects', 'replace', '-f', '-'], { stdin: 'none:\n  name: None\n' }), { code: 1, out: '', err: 'error: no entry none in projects\n' });
});

test('replace takes -f only', () => {
  for (const args of [['checkout', 'name=X'], ['checkout'], []]) {
    assert.match(cli(workspace(), ['projects', 'replace', ...args]).err, /replace takes -f <file> only, patch takes <key> <field>=<value>\.\.\./);
  }
  assert.match(cli(workspace(), ['projects', 'replace', 'checkout', '-f', '-'], { stdin: 'checkout: {}\n' }).err, /replace takes -f <file> only/);
});

// --- delete

test('delete removes the entry and nothing else', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'billing', 'name=Billing']);
  assert.equal(cli(dir, ['projects', 'delete', 'billing']).out, 'projects/billing deleted\n');
  assert.ok(!read(dir, 'project.yaml').includes('billing'));
  assert.match(read(dir, 'project.yaml'), /# kept across every edit/);
});

test('delete of several keys removes each of them', () => {
  const dir = workspace();
  cli(dir, ['projects', 'create', '-f', '-'], { stdin: 'billing:\n  name: Billing\nledger:\n  name: Ledger\n' });
  assert.deepEqual(cli(dir, ['projects', 'delete', 'billing', 'ledger']), { code: 0, out: 'projects/billing deleted\nprojects/ledger deleted\n', err: '' });
});

test('delete -f removes the keys the file holds, whatever their values', () => {
  const dir = workspace();
  cli(dir, ['projects', 'create', '-f', '-'], { stdin: 'billing:\n  name: Billing\nledger:\n  name: Ledger\n' });
  assert.deepEqual(cli(dir, ['projects', 'delete', '-f', '-'], { stdin: 'billing:\n  name: anything\nledger: {}\n' }), { code: 0, out: 'projects/billing deleted\nprojects/ledger deleted\n', err: '' });
  assert.deepEqual(Object.keys(JSON.parse(cli(dir, ['projects', 'list', '-o', 'json']).out)), ['platform', 'checkout']);
});

test('an entry deleted along with every entry naming it is not refused', () => {
  const dir = workspace();
  assert.deepEqual(cli(dir, ['projects', 'delete', 'checkout', 'platform']), { code: 0, out: 'projects/checkout deleted\nprojects/platform deleted\n', err: '' });
});

test('delete of an entry that is not there is refused, and deletes none of the others', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['projects', 'delete', 'none']), { code: 1, out: '', err: 'error: no entry none in projects\n' });
  assert.deepEqual(cli(dir, ['projects', 'delete', 'checkout', 'none']), { code: 1, out: '', err: 'error: no entry none in projects\n' });
  assert.equal(read(dir, 'project.yaml'), before);
});

test('delete --ignore-not-found of an entry that is not there succeeds silently, so a sync can repeat it', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  assert.deepEqual(cli(dir, ['projects', 'delete', 'none', '--ignore-not-found']), { code: 0, out: '', err: '' });
  assert.deepEqual(cli(dir, ['projects', 'delete', '-f', '-', '--ignore-not-found'], { stdin: 'none: {}\n' }), { code: 0, out: '', err: '' });
  assert.equal(read(dir, 'project.yaml'), before);
  assert.equal(cli(dir, ['projects', 'delete', 'checkout', 'none', '--ignore-not-found']).out, 'projects/checkout deleted\n');
});

test('set is not a verb', () => {
  assert.match(cli(workspace(), ['projects', 'set', 'checkout', 'name=X']).err, /unknown verb set, use list, get, create, apply, patch, replace, delete, explain or check/);
});

test('delete of an entry still named by another is refused', () => {
  assert.match(cli(workspace(), ['projects', 'delete', 'platform']).err, /projects\/platform is still named by projects\/checkout: delete or change them first/);
});

test('delete without a key is refused', () => {
  assert.match(cli(workspace(), ['projects', 'delete']).err, /delete needs the key of an entry, or -f <file>/);
});

// --- explain

test('explain lists the fields of an entry with their types', () => {
  const { code, out } = cli(workspace(), ['projects', 'explain']);
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
  const out = cli(workspace(), ['projects', 'explain', 'parent_project']).out;
  assert.match(out, /^FIELD: {2}parent_project <string>\n\nDESCRIPTION:\n {2}Key of the folder holding this project\.\n\nRULES:\n {2}key-of: \.\n {2}target-must: \{"is_folder":true\}\n {2}immutable: moving a project recreates it\n$/);
  assert.match(cli(workspace(), ['projects', 'explain', 'risk_profile.business_impact']).out, /VALUES:\n {2}"LBI", "MBI", "HBI"\n/);
  assert.match(cli(workspace(), ['projects', 'explain', 'name']).out, /DESCRIPTION:\n {2}Display name\.\n {2}Shown in the portal\.\n/);
  assert.match(cli(workspace(), ['projects', 'explain', 'archived']).out, /DEFAULT: {2}false/);
});

test('explain of an object or a list of objects lists what is inside, required fields marked', () => {
  assert.match(cli(workspace(), ['projects', 'explain', 'risk_profile']).out, /FIELDS:\n {2}business_impact {7}<enum> {4}One of LBI, MBI, HBI\.\n {2}regulatory_standards {2}<\[\]enum>\n/);
  assert.match(cli(workspace(), ['projects', 'explain', 'account_links']).out, /FIELD: {2}account_links <\[\]object>\n\nFIELDS:\n {2}account {6}<string> required\n {2}environment {2}<enum>\n/);
});

test('explain of a field that does not exist, or of a file with no schema, is refused', () => {
  assert.match(cli(workspace(), ['projects', 'explain', 'nope']).err, /projects has no field nope/);
  assert.match(cli(workspace(), ['servers', 'explain']).err, /servers\.yml has no schema to explain/);
});

// --- check

test('check of a valid file reports its entries', () => {
  assert.deepEqual(cli(workspace(), ['projects', 'check']), { code: 0, out: 'project.yaml: 2 entries, valid\n', err: '' });
});

test('check of a file edited by hand reports every problem and exits 1', () => {
  const dir = workspace();
  write(dir, 'project.yaml', `${read(dir, 'project.yaml')}  typo:\n    nme: x\n  orphan:\n    parent_project: gone\n`);
  const { code, err } = cli(dir, ['projects', 'check']);
  assert.equal(code, 1);
  assert.match(err, /project\.yaml\.projects\.typo: no such field nme/);
  assert.match(err, /project\.yaml: projects\/orphan: parent_project: gone is not an entry of projects, create it first/);
});

test('check of a file missing a required top-level map fails', () => {
  const dir = workspace();
  write(dir, 'project.yaml', '# yaml-language-server: $schema=schemas/project.schema.json\nprojects_defaults: {}\n');
  assert.match(cli(dir, ['projects', 'check']).err, /project\.yaml: missing required field projects/);
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

test('check --data-file checks that one file', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['check', '--data-file', 'policy.yaml']).out, 'policy.yaml: 2 entries, valid\n');
});

// Checking nothing where the file asked for a check is worse than stopping, so a write refuses and a read only warns.
test('a file naming a schema that cannot be loaded is read with a warning and never written', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', '# yaml-language-server: $schema=schemas/none.json\nitems:\n  one:\n    n: 1\n');
  const before = read(dir, 'a.yaml');
  const refused = cli(dir, ['items', 'apply', 'x', 'n=1']);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /^error: .*a\.yaml names .*none\.json, which does not exist, so it is not written\n$/);
  assert.equal(cli(dir, ['items', 'delete', 'one']).code, 1);
  assert.equal(read(dir, 'a.yaml'), before);
  const listed = cli(dir, ['items', 'list']);
  assert.equal(listed.code, 0);
  assert.match(listed.err, /^warning: .*none\.json, which does not exist, so nothing is checked\n$/);
});

test('a schema with a scheme other than file or http(s) is refused for a write', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', '# yaml-language-server: $schema=ftp://example.com/s.json\nitems: {}\n');
  assert.match(cli(dir, ['items', 'apply', 'x', 'n=1']).err, /names ftp:\/\/example\.com\/s\.json, and only file and http\(s\) schemas are read, so it is not written/);
});

test('a directory with no data file has no resources and nothing to check', () => {
  const dir = emptyDir();
  assert.equal(cli(dir, ['resources']).out, 'RESOURCE   FILE   ENTRIES   SCHEMA\n');
  assert.deepEqual(cli(dir, ['check']), { code: 0, out: '', err: '' });
  assert.match(cli(dir, ['projects', 'list']).err, /no resource projects in .*which holds no YAML data file/);
});

// --- what a pipeline will send sooner or later

test('a value containing = keeps everything after the first one', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'checkout', 'slug=a=b=c']);
  assert.equal(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout.slug, 'a=b=c');
});

test('a key holding dots, dashes or slashes is taken as one key', () => {
  const dir = workspace();
  for (const key of ['app.v2', 'app-v2', 'team/app']) {
    assert.equal(cli(dir, ['projects', 'apply', key, 'name=X']).out, `projects/${key} created\n`);
    assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', key, '-o', 'json']).out), { [key]: { name: 'X' } });
  }
});

test('unicode and quotes survive the round trip', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'checkout', 'name=Caisse « rapide » "v2" ✓']);
  assert.equal(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout.name, 'Caisse « rapide » "v2" ✓');
  assert.equal(cli(dir, ['projects', 'check']).code, 0);
});

test('null sets a nullable field to null, which is different from removing it', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'checkout', 'priority=null']);
  assert.deepEqual(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout.priority, null);
  assert.match(read(dir, 'project.yaml'), /priority: null/);
});

test('a string field takes the text null as it is', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'checkout', 'slug=null']);
  assert.equal(JSON.parse(cli(dir, ['projects', 'get', 'checkout', '-o', 'json']).out).checkout.slug, 'null');
});

test('each item of a list of allowed values is checked', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['projects', 'apply', 'checkout', 'risk_profile.regulatory_standards=["GDPR","SOC"]']).code, 0);
  assert.match(cli(dir, ['projects', 'apply', 'checkout', 'risk_profile.regulatory_standards=["GDPR","HIPAA"]']).err, /regulatory_standards\.1: must be one of "ISO_27001", "SOC", "GDPR"/);
});

test('explain shows the allowed values of a list of them', () => {
  assert.match(cli(workspace(), ['projects', 'explain', 'risk_profile.regulatory_standards']).out, /^FIELD: {2}risk_profile\.regulatory_standards <\[\]enum>\n\nVALUES:\n {2}"ISO_27001", "SOC", "GDPR"\n$/);
});

test('get -o yaml is the default format', () => {
  const dir = workspace();
  assert.equal(cli(dir, ['projects', 'get', 'checkout', '-o', 'yaml']).out, cli(dir, ['projects', 'get', 'checkout']).out);
});

test('several fields set in one command are checked and written together', () => {
  const dir = workspace();
  const before = read(dir, 'project.yaml');
  const { code } = cli(dir, ['projects', 'apply', 'checkout', 'slug=ok', 'priority=many']);
  assert.equal(code, 1);
  assert.equal(read(dir, 'project.yaml'), before, 'the valid field is not written when another fails');
});

test('a file written by yamlctl reads back unchanged by the next command', () => {
  const dir = workspace();
  cli(dir, ['projects', 'apply', 'billing', 'name=Billing', 'account_links=[{"account": "1"}]', 'tags={"team": "a"}']);
  const written = read(dir, 'project.yaml');
  assert.equal(cli(dir, ['projects', 'apply', 'billing', 'name=Billing']).out, 'projects/billing unchanged\n');
  assert.equal(read(dir, 'project.yaml'), written);
  assert.equal(cli(dir, ['check']).code, 0);
});

test('an entry left empty in the file is listed and can be filled', () => {
  const dir = workspace();
  write(dir, 'project.yaml', `${read(dir, 'project.yaml')}  placeholder:\n`);
  assert.match(cli(dir, ['projects', 'list']).out, /placeholder/);
  assert.equal(cli(dir, ['projects', 'apply', 'placeholder', 'name=Filled']).out, 'projects/placeholder configured\n');
});

test('-f reaches a file outside the directory, with its schema found beside it', () => {
  const dir = workspace();
  const other = emptyDir();
  write(other, 'project.yaml', `# yaml-language-server: $schema=${join(dir, 'schemas', 'project.schema.json')}\nprojects: {}\n`);
  assert.equal(cli(dir, ['projects', 'apply', 'x', 'name=X', '--data-file', join(other, 'project.yaml')]).out, 'projects/x created\n');
  assert.match(cli(dir, ['projects', 'apply', 'x', 'nme=X', '--data-file', join(other, 'project.yaml')]).err, /no such field in projects/);
});

test('explain goes into the items of a list of objects', () => {
  assert.match(cli(workspace(), ['projects', 'explain', 'account_links.environment']).out, /^FIELD: {2}account_links\.environment <enum>\n\nVALUES:\n {2}"PRODUCTION", "STAGING"\n$/);
});

test('apply through a list says the list is set whole, rather than that the field does not exist', () => {
  const { code, err } = cli(workspace(), ['projects', 'apply', 'checkout', 'account_links.account=1']);
  assert.equal(code, 1);
  assert.equal(err, `error: account_links.account: goes into a list, which is set whole as JSON: account_links='[...]'\n`);
});
