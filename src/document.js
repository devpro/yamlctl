// A YAML data file read and written in place, so the entries yamlctl does not touch, the comments and the order of the file come back exactly as they were.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from 'yaml';

export function readDocument(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`${file} is not valid YAML: ${doc.errors[0].message}`);
  const data = doc.toJS() ?? {};
  if (typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} does not hold a mapping at its top level`);
  return { file, text, doc, data };
}

// A string a new value holds is double quoted, because unquoted YAML reads `no` as a boolean and `0123` as a number, and a value written by a tool has to read back as the same value.
// No line is folded, since folding a long description would change lines nobody edited.
export function render(doc) {
  return doc.toString({ lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE', defaultKeyType: 'PLAIN' });
}

// Written only when something changed, so running the same command twice leaves the file, and its modification time, alone.
export function writeDocument(document) {
  const next = render(document.doc);
  if (next === document.text) return false;
  writeFileSync(document.file, next);
  return true;
}

export function setEntry(document, map, key, entry) {
  // An empty map is usually written `{}`, and an entry added to it would stay on that one line, so the map becomes a block first.
  const node = document.doc.get(map, true);
  if (node && typeof node === 'object' && 'flow' in node) node.flow = false;
  if (!node || node.items === undefined) document.doc.set(map, document.doc.createNode({}));
  document.doc.setIn([map, key], document.doc.createNode(entry));
}

export function deleteEntry(document, map, key) {
  document.doc.deleteIn([map, key]);
}
