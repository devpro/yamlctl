import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { deleteEntry, readDocument, render, setEntry, writeDocument } from '../src/document.js';
import { emptyDir, read, workspace, write } from './helpers.js';

test('a file read and rendered untouched is the same text', () => {
  const dir = workspace();
  const document = readDocument(join(dir, 'project.yaml'));
  assert.equal(render(document.doc), read(dir, 'project.yaml'));
});

test('nothing is written when nothing changed, so the modification time stays', () => {
  const dir = workspace();
  const path = join(dir, 'project.yaml');
  const before = statSync(path).mtimeMs;
  assert.equal(writeDocument(readDocument(path)), false);
  assert.equal(statSync(path).mtimeMs, before);
});

test('an entry set keeps every other entry, the comments and the order', () => {
  const dir = workspace();
  const document = readDocument(join(dir, 'project.yaml'));
  setEntry(document, 'projects', 'billing', { name: 'Billing' });
  assert.equal(writeDocument(document), true);
  const text = read(dir, 'project.yaml');
  assert.match(text, /^# yaml-language-server: \$schema=schemas\/project\.schema\.json\n# Projects, one entry per application\.\n/);
  assert.match(text, /# kept across every edit\n {4}parent_project: "platform"/);
  assert.ok(text.indexOf('platform:') < text.indexOf('checkout:') && text.indexOf('checkout:') < text.indexOf('billing:'));
});

test('an entry changed keeps the comments inside it and the order of its fields', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', 'items:\n  one:\n    # before a\n    a: 1 # after a\n    b: 2\n    nested:\n      # before x\n      x: 1\n      y: 2\n');
  const document = readDocument(join(dir, 'a.yaml'));
  setEntry(document, 'items', 'one', { c: 3, a: 5, nested: { x: 1, y: 3 } });
  writeDocument(document);
  assert.equal(read(dir, 'a.yaml'), 'items:\n  one:\n    # before a\n    a: 5 # after a\n    nested:\n      # before x\n      x: 1\n      y: 3\n    c: 3\n');
});

test('a new string value is double quoted, so it reads back as the same string', () => {
  const dir = workspace();
  const document = readDocument(join(dir, 'project.yaml'));
  setEntry(document, 'projects', 'x', { name: 'no', account: '005217217997' });
  writeDocument(document);
  assert.match(read(dir, 'project.yaml'), /name: "no"\n {4}account: "005217217997"/);
});

test('a long value is not folded over several lines', () => {
  const dir = workspace();
  const document = readDocument(join(dir, 'project.yaml'));
  const long = 'word '.repeat(60).trim();
  setEntry(document, 'projects', 'x', { name: long });
  writeDocument(document);
  assert.ok(read(dir, 'project.yaml').includes(`name: "${long}"`));
});

test('an entry added to an empty {} map makes it a block', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', 'items: {}\n');
  const document = readDocument(join(dir, 'a.yaml'));
  setEntry(document, 'items', 'one', { name: 'One' });
  writeDocument(document);
  assert.equal(read(dir, 'a.yaml'), 'items:\n  one:\n    name: "One"\n');
});

test('an entry added to a map left empty, or missing, creates it', () => {
  const dir = emptyDir();
  write(dir, 'a.yaml', 'items:\nother: 1\n');
  const document = readDocument(join(dir, 'a.yaml'));
  setEntry(document, 'items', 'one', { n: 1 });
  setEntry(document, 'fresh', 'two', { n: 2 });
  writeDocument(document);
  assert.equal(read(dir, 'a.yaml'), 'items:\n  one:\n    n: 1\nother: 1\nfresh:\n  two:\n    n: 2\n');
});

test('an entry deleted takes nothing else with it', () => {
  const dir = workspace();
  const document = readDocument(join(dir, 'project.yaml'));
  deleteEntry(document, 'projects', 'checkout');
  writeDocument(document);
  const text = read(dir, 'project.yaml');
  assert.ok(!text.includes('checkout:'));
  assert.match(text, /platform:\n {4}name: "Platform"/);
});

test('a file that is not YAML is refused with the parser message', () => {
  const dir = emptyDir();
  write(dir, 'bad.yaml', 'a: [1, 2\n');
  assert.throws(() => readDocument(join(dir, 'bad.yaml')), /bad\.yaml is not valid YAML/);
});

test('a file holding a list at the top is refused', () => {
  const dir = emptyDir();
  write(dir, 'list.yaml', '- a\n- b\n');
  assert.throws(() => readDocument(join(dir, 'list.yaml')), /does not hold a mapping at its top level/);
});

test('an empty file reads as an empty mapping', () => {
  const dir = emptyDir();
  write(dir, 'empty.yaml', '');
  assert.deepEqual(readDocument(join(dir, 'empty.yaml')).data, {});
});

test('a file that does not exist is named', () => {
  assert.throws(() => readDocument(join(emptyDir(), 'none.yaml')), /cannot read .*none\.yaml/);
});
