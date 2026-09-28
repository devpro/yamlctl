import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Schema } from '../src/schema.js';
import { checkAll, checkSet, defaultsOf, fieldRules, referencesTo } from '../src/rules.js';

// A tree of folders and items, the smallest schema using every rule.
const schema = new Schema({
  type: 'object',
  properties: {
    nodes: { type: 'object', additionalProperties: { $ref: '#/definitions/node' }, 'x-yamlctl': { defaults: 'nodes_defaults' } },
    nodes_defaults: { $ref: '#/definitions/node' },
    links: { type: 'object', additionalProperties: { $ref: '#/definitions/link' } },
  },
  definitions: {
    node: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        folder: { type: 'boolean' },
        parent: { type: 'string', 'x-yamlctl': { 'key-of': '.', 'target-must': { folder: true }, immutable: 'a move recreates the node' } },
      },
    },
    link: {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' }, 'x-yamlctl': { 'key-of': 'nodes' } },
        pinned: { type: 'string', 'x-yamlctl': { immutable: true } },
      },
    },
  },
});

const data = () => ({
  nodes_defaults: { folder: false },
  nodes: { root: { name: 'Root', folder: true }, leaf: { name: 'Leaf', parent: 'root' }, file: { name: 'File' } },
  links: { l1: { targets: ['leaf', 'root'], pinned: 'a' } },
});

test('the fields carrying rules are read off the entry schema', () => {
  assert.deepEqual(fieldRules(schema, 'nodes').map((rule) => rule.field), ['parent']);
  assert.deepEqual(fieldRules(schema, 'links').map((rule) => rule.field), ['targets', 'pinned']);
});

test('the defaults a map declares are read, and a map declaring none has none', () => {
  assert.deepEqual(defaultsOf(schema, data(), 'nodes'), { folder: false });
  assert.deepEqual(defaultsOf(schema, data(), 'links'), {});
  assert.deepEqual(defaultsOf(null, data(), 'nodes'), {});
});

test('a reference to an entry that exists and satisfies the target rule passes', () => {
  assert.deepEqual(checkSet({ schema, data: data(), map: 'nodes', key: 'new', entry: { parent: 'root' } }), []);
});

test('a reference to an entry that does not exist is refused', () => {
  assert.deepEqual(checkSet({ schema, data: data(), map: 'nodes', key: 'new', entry: { parent: 'nowhere' } }), ['parent: nowhere is not an entry of nodes, set it first']);
});

test('an entry naming itself is refused', () => {
  assert.deepEqual(checkSet({ schema, data: data(), map: 'nodes', key: 'root', entry: { parent: 'root', folder: true }, force: true }), ['parent: root cannot name itself']);
});

test('a target that fails its rule is refused, read with the target map defaults', () => {
  // `file` sets no folder, so the default false is what it has.
  assert.deepEqual(checkSet({ schema, data: data(), map: 'nodes', key: 'new', entry: { parent: 'file' } }), ['parent: file must have folder: true, it has false']);
});

test('a reference inherited from the defaults is checked like one set on the entry', () => {
  const d = data();
  d.nodes_defaults.parent = 'file';
  assert.deepEqual(checkSet({ schema, data: d, map: 'nodes', key: 'new', entry: {} }), ['parent: file must have folder: true, it has false']);
});

test('a reference into another map checks every name in a list', () => {
  assert.deepEqual(checkSet({ schema, data: data(), map: 'links', key: 'l2', entry: { targets: ['leaf', 'ghost'] } }), ['targets: ghost is not an entry of nodes, set it first']);
});

test('changing an immutable value on an existing entry needs force, and says why', () => {
  const problems = checkSet({ schema, data: data(), map: 'nodes', key: 'leaf', entry: { name: 'Leaf', parent: 'root', folder: true } });
  assert.deepEqual(problems, []);
  const d = data();
  d.nodes.other = { folder: true };
  assert.deepEqual(checkSet({ schema, data: d, map: 'nodes', key: 'leaf', entry: { parent: 'other' } }), ['parent: changing "root" to "other" needs --force, a move recreates the node']);
  assert.deepEqual(checkSet({ schema, data: d, map: 'nodes', key: 'leaf', entry: { parent: 'other' }, force: true }), []);
});

test('an immutable rule declared as true refuses without a reason', () => {
  assert.deepEqual(checkSet({ schema, data: data(), map: 'links', key: 'l1', entry: { targets: ['root'], pinned: 'b' } }), ['pinned: changing "a" to "b" needs --force']);
});

test('removing an immutable value is a change like any other', () => {
  assert.deepEqual(checkSet({ schema, data: data(), map: 'nodes', key: 'leaf', entry: { name: 'Leaf' } }), ['parent: changing "root" to null needs --force, a move recreates the node']);
});

test('an immutable value on a new entry is free', () => {
  assert.deepEqual(checkSet({ schema, data: data(), map: 'links', key: 'l9', entry: { pinned: 'z' } }), []);
});

test('without a schema there are no rules to break', () => {
  assert.deepEqual(checkSet({ schema: null, data: data(), map: 'nodes', key: 'x', entry: { parent: 'nowhere' } }), []);
});

test('every entry naming one about to be deleted is found, in any map of the file', () => {
  assert.deepEqual(referencesTo({ schema, data: data(), map: 'nodes', key: 'root' }), ['nodes/leaf', 'links/l1']);
  assert.deepEqual(referencesTo({ schema, data: data(), map: 'nodes', key: 'file' }), []);
  assert.deepEqual(referencesTo({ schema: null, data: data(), map: 'nodes', key: 'root' }), []);
});

test('a file edited by hand is checked entry by entry, immutability aside', () => {
  const d = data();
  d.nodes.orphan = { parent: 'gone' };
  d.links.l2 = { targets: ['file', 'ghost'] };
  assert.deepEqual(checkAll({ schema, data: d }), ['nodes/orphan: parent: gone is not an entry of nodes, set it first', 'links/l2: targets: ghost is not an entry of nodes, set it first']);
  assert.deepEqual(checkAll({ schema, data: data() }), []);
});
