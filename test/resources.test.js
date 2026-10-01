import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { dataFiles, listResources, openFile, resolveResource } from '../src/resources.js';
import { emptyDir, workspace, write } from './helpers.js';

test('a resource is a map, found in the file holding it', () => {
  const dir = workspace();
  const target = resolveResource({ dir, name: 'projects' });
  assert.equal(target.file, join(dir, 'project.yaml'));
  assert.equal(target.map, 'projects');
});

test('a map in a .yml file is found the same way', () => {
  const dir = workspace();
  const target = resolveResource({ dir, name: 'servers' });
  assert.equal(target.file, join(dir, 'servers.yml'));
  assert.equal(target.map, 'servers');
});

test('the singular a map declares names the same resource', () => {
  const dir = workspace();
  const target = resolveResource({ dir, name: 'project' });
  assert.equal(target.file, join(dir, 'project.yaml'));
  assert.equal(target.map, 'projects');
  assert.equal(resolveResource({ dir, name: 'project', file: join(dir, 'project.yaml') }).map, 'projects');
});

test('a singular no schema declares is not guessed', () => {
  assert.throws(() => resolveResource({ dir: workspace(), name: 'scan_policy' }), /no resource scan_policy in /);
  assert.throws(() => resolveResource({ dir: workspace(), name: 'server' }), /no resource server in /);
});

test('a file name is refused, naming the maps it holds', () => {
  const dir = workspace();
  assert.throws(() => resolveResource({ dir, name: 'policy.yaml' }), /policy\.yaml is a file rather than a resource, use yamlctl ignore_rules \.\.\., yamlctl scan_policies \.\.\./);
});

test('a map two files hold under one stem is refused, naming --data-file', () => {
  const dir = workspace();
  write(dir, 'project.yml', 'projects: {}\n');
  assert.throws(() => resolveResource({ dir, name: 'projects' }), /project\.yaml and project\.yml both hold a map projects, name one with --data-file/);
});

test('a map name is found in whichever file holds it', () => {
  const dir = workspace();
  const target = resolveResource({ dir, name: 'scan_policies' });
  assert.equal(target.file, join(dir, 'policy.yaml'));
  assert.equal(target.map, 'scan_policies');
});

test('a map two files hold is refused, naming both', () => {
  const dir = workspace();
  write(dir, 'more.yaml', 'scan_policies:\n  other:\n    name: x\n');
  assert.throws(() => resolveResource({ dir, name: 'scan_policies' }), /more\.yaml and policy\.yaml both hold a map scan_policies/);
});

test('an unknown name lists the resources that exist', () => {
  assert.throws(() => resolveResource({ dir: workspace(), name: 'nothing' }), /no resource nothing in .*, the resources are ignore_rules, scan_policies, projects, servers/);
});

test('an unknown name in a directory with no data file says so', () => {
  assert.throws(() => resolveResource({ dir: emptyDir(), name: 'x' }), /which holds no YAML data file/);
});

test('--data-file names the file, and the resource is one of its maps', () => {
  const dir = workspace();
  const file = join(dir, 'policy.yaml');
  assert.throws(() => resolveResource({ dir, name: 'policy', file }), /policy\.yaml holds no map policy/);
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
  const rows = listResources(dir).map(({ name, singular, file, entries, schema }) => [name, singular, file.slice(dir.length + 1), entries, schema && schema.slice(dir.length + 1)]);
  assert.deepEqual(rows, [
    ['ignore_rules', null, 'policy.yaml', 1, 'schemas/policy.schema.json'],
    ['scan_policies', null, 'policy.yaml', 1, 'schemas/policy.schema.json'],
    ['projects', 'project', 'project.yaml', 2, 'schemas/project.schema.json'],
    ['servers', null, 'servers.yml', 2, null],
  ]);
});

test('a file that cannot be read is listed with its error rather than hiding the others', () => {
  const dir = workspace();
  write(dir, 'broken.yaml', 'a: [\n');
  const broken = listResources(dir).find((row) => row.file.endsWith('broken.yaml'));
  assert.equal(broken.name, null);
  assert.match(broken.error, /not valid YAML/);
});

test('a file holding no map of entries holds no resource', () => {
  const dir = emptyDir();
  write(dir, 'settings.yaml', 'debug: true\n');
  assert.deepEqual(listResources(dir), []);
  assert.throws(() => resolveResource({ dir, name: 'settings' }), /settings\.yaml is a file rather than a resource, and holds no map of entries/);
});
