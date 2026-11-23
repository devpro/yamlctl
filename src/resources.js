// What a resource name on the command line points at: a map of entries, and the file holding it.
//
// A resource is always a map and never a file, so `yamlctl projects list` reads the `projects:` map of whichever file holds it.
// Naming a file holding one map after its file instead made the same kind of thing singular in one place and plural in the next, and renamed it the day a second map joined the file.
// The singular is accepted as well, `yamlctl project list`, only where the schema declares it, the way kubectl reads `names.singular` off a resource rather than guessing at English.
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
  const singulars = Object.fromEntries(maps.map((map) => [map, schema?.mapOptions(map).singular]).filter(([, singular]) => typeof singular === 'string' && singular));
  const schemaPath = schema ? schema.path : namedPath(found);
  return { file, document, schema, schemaPath, schemaError, maps, singulars };
}

const namedPath = (found) => (found.uri ? displayUri(found.uri) : null);

// The map a name on the command line means in one opened file: the map of that name, else the one declaring it as its singular.
function mapNamed(opened, name) {
  if (opened.maps.includes(name)) return name;
  return opened.maps.find((map) => opened.singulars[map] === name) ?? null;
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
export function resolveResource({ dir, name, file = null }) {
  if (file) {
    const opened = openFile(file);
    const map = mapNamed(opened, name);
    if (map) return { ...opened, map };
    throw new Error(`${file} holds no map ${name}, only ${opened.maps.join(', ') || 'none'}`);
  }

  const files = dataFiles(dir);
  const holding = [];
  for (const path of files) {
    const opened = openFile(path);
    const map = mapNamed(opened, name);
    if (map) holding.push({ ...opened, map });
  }
  if (holding.length === 1) return holding[0];
  if (holding.length > 1) throw new Error(`${holding.map((h) => basename(h.file)).join(' and ')} both hold a map ${name}, name one with --data-file`);
  // A file name is the likeliest wrong guess, so it is answered with the maps it holds rather than with every resource of the directory.
  const named = files.filter((path) => stem(path) === name || basename(path) === name);
  if (named.length) {
    const maps = [...new Set(named.flatMap((path) => openFile(path).maps))];
    const commands = maps.map((map) => `yamlctl ${map} ...`).join(', ');
    const hint = maps.length ? `use ${commands}` : 'and holds no map of entries';
    throw new Error(`${named.map((path) => basename(path)).join(' and ')} ${named.length > 1 ? 'are files' : 'is a file'} rather than a resource, ${hint}`);
  }
  const known = listResources(dir).filter((resource) => resource.name).map((resource) => resource.name);
  if (known.length) throw new Error(`no resource ${name} in ${dir}, the resources are ${known.join(', ')}`);
  throw new Error(`no resource ${name} in ${dir}, which holds no ${files.length ? 'map of entries' : 'YAML data file'}`);
}

// Every name the command line accepts, the way `kubectl api-resources` lists them.
// A file that cannot be read is listed with its error and no name, since hiding it would hide the resources it holds.
export function listResources(dir) {
  const out = [];
  for (const path of dataFiles(dir)) {
    let opened;
    try {
      opened = openFile(path);
    } catch (e) {
      out.push({ name: null, singular: null, file: path, entries: null, schema: null, error: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const schema = opened.schema ? opened.schemaPath : null;
    for (const map of opened.maps) out.push({ name: map, singular: opened.singulars[map] ?? null, file: path, entries: count(opened, map), schema });
  }
  return out;
}

const count = (opened, map) => Object.keys(opened.document.data[map] ?? {}).length;
