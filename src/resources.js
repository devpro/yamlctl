// What a resource name on the command line points at: a file and the map of entries inside it.
//
// `yamlctl project list` reads project.yaml, or project.yml, and `yamlctl ignore_rules list` reads whichever file holds a map of that name, so a file holding one map and a file holding several are both reached without naming anything twice.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readDocument } from './document.js';
import { Schema, displayUri, findSchema } from './schema.js';
import { documentAt, hasDocument } from './store.js';

export const YAML = /\.ya?ml$/;

// One data file with its schema, if it has one, and the maps of entries it holds.
// `schemaError` is set when the file names a schema that cannot be loaded, which a command reading the file warns about and a command writing it refuses on.
export function openFile(file) {
  const document = readDocument(file);
  const found = findSchema(file, document.text);
  let schema = null;
  let schemaError = null;
  if (found.unsupported) {
    schemaError = `names ${found.uri}, and only file and http(s) schemas are read`;
  } else if (found.uri && (hasDocument(found.uri) || !found.uri.startsWith('file:'))) {
    try {
      schema = new Schema(documentAt(found.uri), found.uri);
    } catch (e) {
      schemaError = `names a schema that cannot be used: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else if (found.named) {
    schemaError = `names ${displayUri(found.uri)}, which does not exist`;
  }
  const maps = schema ? schema.entryMaps() : mapsWithoutSchema(document.data);
  return { file, document, schema, schemaPath: schema ? schema.path : found.uri ? displayUri(found.uri) : null, schemaError, maps };
}

// Without a schema, a map of entries is a mapping whose every value is itself a mapping, or empty: `servers: {web: {...}, db: {...}}`.
// Defaults beside it, `servers_defaults: {port: 80}`, hold a scalar and are left out by the same rule.
function mapsWithoutSchema(data) {
  return Object.keys(data).filter((key) => {
    const value = data[key];
    if (value === null) return false;
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.values(value).every((entry) => entry === null || (typeof entry === 'object' && !Array.isArray(entry)));
  });
}

export function dataFiles(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  return readdirSync(dir)
    .filter((name) => YAML.test(name))
    .sort()
    .map((name) => join(dir, name));
}

const stem = (file) => basename(file).replace(YAML, '');

// The file and map a resource name points at.
// `map` is null when the name is a file holding several maps, which `list` and `check` accept and the commands acting on one entry refuse, naming the maps to use instead.
export function resolveResource({ dir, name, file = null }) {
  if (file) {
    const opened = openFile(file);
    if (name === stem(file) || name === basename(file)) return single(opened);
    if (opened.maps.includes(name)) return { ...opened, map: name };
    throw new Error(`${file} holds no map ${name}, only ${opened.maps.join(', ') || 'none'}`);
  }

  const files = dataFiles(dir);
  const byStem = files.filter((path) => stem(path) === name);
  if (byStem.length > 1) throw new Error(`${byStem.map((path) => basename(path)).join(' and ')} both exist, name one with --data-file`);
  if (byStem.length === 1) return single(openFile(byStem[0]));

  const holding = [];
  for (const path of files) {
    const opened = openFile(path);
    if (opened.maps.includes(name)) holding.push({ ...opened, map: name });
  }
  if (holding.length === 1) return holding[0];
  if (holding.length > 1) throw new Error(`${holding.map((h) => basename(h.file)).join(' and ')} both hold a map ${name}, name one with --data-file`);
  const known = listResources(dir).map((resource) => resource.name);
  throw new Error(`no resource ${name} in ${dir}${known.length ? `, the resources are ${known.join(', ')}` : ', which holds no YAML data file'}`);
}

function single(opened) {
  return { ...opened, map: opened.maps.length === 1 ? opened.maps[0] : null };
}

// Every name the command line accepts, the way `kubectl api-resources` lists them.
export function listResources(dir) {
  const out = [];
  for (const path of dataFiles(dir)) {
    let opened;
    try {
      opened = openFile(path);
    } catch (e) {
      out.push({ name: stem(path), file: path, map: null, entries: null, schema: null, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const schema = opened.schema ? opened.schemaPath : null;
    if (opened.maps.length === 1) {
      out.push({ name: stem(path), file: path, map: opened.maps[0], entries: count(opened, opened.maps[0]), schema });
      continue;
    }
    for (const map of opened.maps) out.push({ name: map, file: path, map, entries: count(opened, map), schema });
    if (!opened.maps.length) out.push({ name: stem(path), file: path, map: null, entries: 0, schema });
  }
  return out;
}

const count = (opened, map) => Object.keys(opened.document.data[map] ?? {}).length;
