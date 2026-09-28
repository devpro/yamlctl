import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dataFiles, listResources, openFile, resolveResource } from '../src/resources.js';
import { emptyDir, workspace, write } from './helpers.js';

test('a resource named after a .yaml file is that file and its one map', () => {
  const dir = workspace();
  const target = resolveResource({ dir, name: 'project' });
  assert.equal(target.file, join(dir, 'project.yaml'));
  assert.equal(target.map, 'projects');
});

test('a resource named after a .yml file is found the same way', () => {
  const dir = workspace();
  const target = resolveResource({ dir, name: 'servers' });
  assert.equal(target.file, join(dir, 'servers.yml'));
  assert.equal(target.map, 'servers');
});

test('both project.yaml and project.yml is refused, naming -f', () => {
  const dir = workspace();
  write(dir, 'project.yml', 'projects: {}\n');
  assert.throws(() => resolveResource({ dir, name: 'project' }), /project\.yaml and project\.yml both exist, name one with -f/);
});

test('a map name is found in whichever file holds it', () => {
  const dir = workspace();
  const target = resolveResource({ dir, name: 'scan_policies' });
  assert.equal(target.file, join(dir, 'policy.yaml'));
  assert.equal(target.map, 'scan_policies');
});

test('a file holding several maps resolves with no map, and its maps listed', () => {
  const target = resolveResource({ dir: workspace(), name: 'policy' });
  assert.equal(target.map, null);
  assert.deepEqual(target.maps, ['ignore_rules', 'scan_policies']);
});

test('a map two files hold is refused, naming both', () => {
  const dir = workspace();
  write(dir, 'more.yaml', 'scan_policies:\n  other:\n    name: x\n');
  assert.throws(() => resolveResource({ dir, name: 'scan_policies' }), /more\.yaml and policy\.yaml both hold a map scan_policies/);
});

test('an unknown name lists the resources that exist', () => {
  assert.throws(() => resolveResource({ dir: workspace(), name: 'nothing' }), /no resource nothing in .*, the resources are ignore_rules, scan_policies, project, servers/);
});

test('an unknown name in a directory with no data file says so', () => {
  assert.throws(() => resolveResource({ dir: emptyDir(), name: 'x' }), /which holds no YAML data file/);
});

test('-f names the file, and the resource is its name or one of its maps', () => {
  const dir = workspace();
  const file = join(dir, 'policy.yaml');
  assert.equal(resolveResource({ dir, name: 'policy', file }).map, null);
  assert.equal(resolveResource({ dir, name: 'policy.yaml', file }).map, null);
  assert.equal(resolveResource({ dir, name: 'ignore_rules', file }).map, 'ignore_rules');
  assert.throws(() => resolveResource({ dir, name: 'rules', file }), /policy\.yaml holds no map rules, only ignore_rules, scan_policies/);
});

test('-f reaches a file whose name the directory does not use', () => {
  const dir = emptyDir();
  write(dir, 'inventory.txt', 'hosts:\n  web:\n    ip: 10.0.0.1\n');
  const target = resolveResource({ dir, name: 'hosts', file: join(dir, 'inventory.txt') });
  assert.equal(target.map, 'hosts');
});

test('a directory that does not exist is named', () => {
  assert.throws(() => dataFiles(join(emptyDir(), 'none')), /is not a directory/);
});

test('only .yaml and .yml files are data files, sorted', () => {
  const dir = workspace();
  write(dir, 'notes.txt', 'x');
  write(dir, 'a.yml', 'a: {}\n');
  assert.deepEqual(dataFiles(dir).map((path) => path.slice(dir.length + 1)), ['a.yml', 'policy.yaml', 'project.yaml', 'servers.yml']);
});

test('without a schema, a map of maps is a map of entries and its defaults are not', () => {
  const dir = workspace();
  assert.deepEqual(openFile(join(dir, 'servers.yml')).maps, ['servers']);
});

test('without a schema, a scalar, a list or an empty value is not a map of entries', () => {
  const dir = emptyDir();
  write(dir, 'mixed.yaml', 'name: x\nlist: [1]\nempty:\nentries:\n  a: {}\n  b:\n');
  assert.deepEqual(openFile(join(dir, 'mixed.yaml')).maps, ['entries']);
});

test('a file naming a schema that does not exist says so rather than checking nothing quietly', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', '# yaml-language-server: $schema=schemas/missing.json\nitems: {}\n');
  const opened = openFile(join(dir, 'a.yaml'));
  assert.equal(opened.schema, null);
  assert.match(opened.schemaError, /names .*missing\.json, which does not exist/);
});

test('a remote schema nothing fetched is reported rather than read from the network here', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', '# yaml-language-server: $schema=https://example.invalid/never.json\nitems: {}\n');
  assert.match(openFile(join(dir, 'a.yaml')).schemaError, /names a schema that cannot be used: https:\/\/example\.invalid\/never\.json was not fetched/);
});

test('every resource is listed with its file, map, entry count and schema', () => {
  const dir = workspace();
  const rows = listResources(dir).map(({ name, map, entries, schema }) => [name, map, entries, schema && schema.slice(dir.length + 1)]);
  assert.deepEqual(rows, [
    ['ignore_rules', 'ignore_rules', 1, 'schemas/policy.schema.json'],
    ['scan_policies', 'scan_policies', 1, 'schemas/policy.schema.json'],
    ['project', 'projects', 2, 'schemas/project.schema.json'],
    ['servers', 'servers', 2, null],
  ]);
});

test('a file that cannot be read is listed with its error rather than hiding the others', () => {
  const dir = workspace();
  write(dir, 'broken.yaml', 'a: [\n');
  const broken = listResources(dir).find((row) => row.name === 'broken');
  assert.match(broken.error, /not valid YAML/);
});

test('a file holding no map of entries is still listed', () => {
  const dir = emptyDir();
  write(dir, 'settings.yaml', 'debug: true\n');
  assert.deepEqual(listResources(dir).map(({ name, map, entries }) => [name, map, entries]), [['settings', null, 0]]);
});
