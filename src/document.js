// A YAML data file read and written in place, so the entries yamlctl does not touch, the comments and the order of the file come back exactly as they were.
import { readFileSync, writeFileSync } from 'node:fs';
import { isMap, parseDocument } from 'yaml';

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
  const { doc } = document;
  // An empty map is usually written `{}`, and an entry added to it would stay on that one line, so the map becomes a block first.
  const node = doc.get(map, true);
  if (node && typeof node === 'object' && 'flow' in node) node.flow = false;
  if (!node || node.items === undefined) doc.set(map, doc.createNode({}));
  const current = doc.getIn([map, key], true);
  if (isMap(current)) update(doc, current, entry);
  else doc.setIn([map, key], doc.createNode(entry));
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// An entry already in the file is changed field by field rather than rebuilt, since a node built anew carries none of the comments written inside the old one.
// A field keeps its place, a new one goes last, and a value replaced keeps the comments written before and after it.
function update(doc, node, value) {
  for (const pair of [...node.items]) {
    const key = pair.key?.value ?? pair.key;
    if (!Object.hasOwn(value, key)) node.delete(key);
  }
  for (const [key, next] of Object.entries(value)) {
    const child = node.get(key, true);
    if (isMap(child) && isObject(next)) {
      update(doc, child, next);
      continue;
    }
    if (child && typeof child.toJSON === 'function' && JSON.stringify(child.toJSON()) === JSON.stringify(next)) continue;
    const fresh = doc.createNode(next);
    if (child && typeof child === 'object') {
      fresh.commentBefore = child.commentBefore;
      fresh.comment = child.comment;
      fresh.spaceBefore = child.spaceBefore;
    }
    node.set(key, fresh);
  }
}

export function deleteEntry(document, map, key) {
  document.doc.deleteIn([map, key]);
}
