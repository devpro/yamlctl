// The JSON Schema a data file is checked against: where it is, what its entries look like, and how a value typed on a command line becomes the value the schema expects.
//
// Nothing here knows what the data means.
// Every rule beyond the schema's own keywords comes from `x-yamlctl`, documented in docs/schema-extensions.md, so the tool stays the same whatever the files describe.
//
// Every location is an absolute URI with a JSON pointer fragment, `file:///.../project.schema.json#/definitions/project` or `https://.../schema.json#/$defs/x`.
// That is what lets a `$ref` lead into another file or onto the network and back with nothing treated as a special case.
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { baseOf, documentAt, hasDocument, isRemote, referencedDocuments } from './store.js';

const require = createRequire(import.meta.url);
const Ajv = require('ajv').default;
const Ajv2019 = require('ajv/dist/2019').default;
const Ajv2020 = require('ajv/dist/2020').default;

export const EXTENSION = 'x-yamlctl';

// The comment the YAML language server reads, so an editor and yamlctl always check a file against the same schema.
export const SCHEMA_LINE = /^#\s*yaml-language-server:\s*\$schema=(\S+)/m;

// The schema a file names on its own, else the usual places beside it: a schemas folder, then the file's own directory.
// The answer is a URI, `file:` or `https:`, and `named` says whether the file asked for it, which decides whether its absence is an error.
export function findSchema(file, text) {
  const named = text.match(SCHEMA_LINE)?.[1];
  if (named) {
    if (isRemote(named)) return { uri: named, named: true };
    if (/^[a-z][a-z0-9+.-]*:/i.test(named) && !named.startsWith('file:')) return { uri: named, named: true, unsupported: true };
    if (named.startsWith('file:')) return { uri: named, named: true };
    return { uri: pathToFileURL(isAbsolute(named) ? named : join(dirname(file), named)).href, named: true };
  }
  const name = `${basename(file).replace(/\.ya?ml$/, '')}.schema.json`;
  const found = [join(dirname(file), 'schemas', name), join(dirname(file), name)].find((path) => existsSync(path));
  return { uri: found ? pathToFileURL(found).href : null, named: false };
}

// A schema file on disk, for a caller holding a path rather than a URI.
export function loadSchema(pathOrUri) {
  const uri = /^(file|https?):/i.test(pathOrUri) ? pathOrUri : pathToFileURL(pathOrUri).href;
  return new Schema(documentAt(uri), uri);
}

// How a schema's location is shown: a path for a file, the address for anything else.
export const displayUri = (uri) => (uri?.startsWith('file:') ? fileURLToPath(uri) : uri);

function splitPointer(pointer) {
  const at = pointer.indexOf('#');
  return at === -1 ? [pointer, ''] : [pointer.slice(0, at), pointer.slice(at + 1)];
}

// A JSON pointer fragment, `/definitions/project`, as the path of keys it walks.
// A plain name, `#thing`, is an `$anchor`, which is left to the validator rather than followed here.
function pointerKeys(fragment, pointer) {
  if (fragment && !fragment.startsWith('/')) throw new Error(`${pointer} names an anchor, which is not followed`);
  return fragment
    .split('/')
    .filter(Boolean)
    .map((key) => decodeURIComponent(key).replace(/~1/g, '/').replace(/~0/g, '~'));
}

const isNull = (schema) => schema?.type === 'null' || (Array.isArray(schema?.type) && schema.type.length === 1 && schema.type[0] === 'null');

export class Schema {
  // `uri` defaults to an address of its own for a schema built in memory.
  // It has a path, unlike a `urn:`, since a URL parser following the WHATWG standard refuses to resolve a relative reference against an opaque one, and the reference would then be dropped rather than reported as missing.
  constructor(root, uri = 'yamlctl:/inline') {
    this.root = root;
    this.uri = uri;
    this.path = displayUri(uri);
    this.documents = new Map([[uri, root]]);
    this.bases = new Map([[uri, baseOf(root, uri)]]);
    this.missing = [];
    const draft = String(root.$schema ?? '');
    const Validator = draft.includes('2020-12') ? Ajv2020 : draft.includes('2019-09') ? Ajv2019 : Ajv;
    // Unknown formats and keywords are tolerated rather than refused, since a schema written for an editor carries both and they say nothing about validity.
    this.ajv = new Validator({ allErrors: true, strict: false, validateFormats: false });
    this.ajv.addKeyword(EXTENSION);
    this.ajv.addSchema(root, uri);

    // Every document a reference can reach is given to the validator up front, since it compiles synchronously and cannot go looking for one halfway through.
    const added = new Set([root]);
    const queue = referencedDocuments(root, this.bases.get(uri));
    while (queue.length) {
      const next = queue.shift();
      if (this.documents.has(next)) continue;
      if (!hasDocument(next)) {
        this.missing.push(next);
        this.documents.set(next, null);
        continue;
      }
      const document = documentAt(next);
      this.documents.set(next, document);
      this.bases.set(next, baseOf(document, next));
      if (!added.has(document)) {
        added.add(document);
        this.ajv.addSchema(document, next);
      }
      queue.push(...referencedDocuments(document, this.bases.get(next)));
    }
  }

  // A pointer relative to the root, `#/definitions/project`, or absolute, `<uri>#/definitions/project`.
  absolute(pointer) {
    return pointer.startsWith('#') ? `${this.uri}${pointer}` : pointer;
  }

  at(pointer) {
    const full = this.absolute(pointer);
    const [uri, fragment] = splitPointer(full);
    let node = this.documents.get(uri);
    if (!node) throw new Error(this.missing.includes(uri) ? `${displayUri(uri)} is referenced by the schema and could not be loaded` : `${displayUri(uri)} is not a document this schema reaches`);
    for (const key of pointerKeys(fragment, full)) {
      node = node?.[key];
      if (node === undefined) throw new Error(`${displayUri(uri)} has nothing at #${fragment}`);
    }
    return { schema: node, pointer: full };
  }

  // A schema with its reference followed and a nullable wrapper taken off, as the pointer ajv can compile and the object a walk can read.
  // `anyOf: [{$ref}, {type: null}]` is how a value that may be left empty is usually written, and the empty branch says nothing about the value's shape.
  unwrap(pointer, depth = 0) {
    if (depth > 32) throw new Error(`${pointer} references itself too deeply to follow`);
    const { schema, pointer: full } = this.at(pointer);
    if (schema?.$ref) {
      const [uri] = splitPointer(full);
      let target;
      try {
        target = new URL(schema.$ref, this.bases.get(uri) ?? uri).href;
      } catch {
        throw new Error(`${schema.$ref} is not a reference that can be followed`);
      }
      return this.unwrap(target.includes('#') ? target : `${target}#`, depth + 1);
    }
    for (const keyword of ['anyOf', 'oneOf']) {
      const options = schema?.[keyword];
      if (!Array.isArray(options)) continue;
      const kept = options.map((option, i) => ({ option, i })).filter(({ option }) => !isNull(option));
      if (kept.length === 1) return this.unwrap(`${full}/${keyword}/${kept[0].i}`, depth + 1);
    }
    return { schema, pointer: full };
  }

  child(pointer, key) {
    const { schema, pointer: here } = this.unwrap(pointer);
    if (schema?.properties && Object.hasOwn(schema.properties, key)) return this.unwrap(`${here}/properties/${escapeKey(key)}`);
    if (schema?.patternProperties) {
      for (const pattern of Object.keys(schema.patternProperties)) {
        if (new RegExp(pattern, 'u').test(key)) return this.unwrap(`${here}/patternProperties/${escapeKey(pattern)}`);
      }
    }
    if (schema?.additionalProperties && typeof schema.additionalProperties === 'object') return this.unwrap(`${here}/additionalProperties`);
    return null;
  }

  // The top-level properties holding a map of entries: an object whose values all follow one schema, rather than an object with fields of its own.
  // That shape is all it takes, so a schema needs nothing added for yamlctl to find its entries.
  entryMaps() {
    const properties = this.root.properties ?? {};
    return Object.keys(properties).filter((name) => {
      if (properties[name]?.[EXTENSION]?.entries === false) return false;
      const { schema, pointer } = this.unwrap(`#/properties/${escapeKey(name)}`);
      if (!types(schema).includes('object') || schema.properties || !schema.additionalProperties || typeof schema.additionalProperties !== 'object') return false;
      // A map of strings, labels or tags, has values rather than entries, and an entry is something with fields.
      const entry = types(this.unwrap(`${pointer}/additionalProperties`).schema);
      return !entry.length || entry.includes('object');
    });
  }

  // What the map itself declares for yamlctl: which sibling holds its defaults, which field names an entry.
  mapOptions(name) {
    return this.root.properties?.[name]?.[EXTENSION] ?? {};
  }

  entryPointer(map) {
    return this.unwrap(`#/properties/${escapeKey(map)}/additionalProperties`).pointer;
  }

  // The schema a field path leads to, or null for a path naming no field.
  // `throughLists` lets a path go into the items of a list, `account_links.account`, which explaining a field needs and setting one does not, since a list is set whole.
  // `crossed` says whether it did, so a caller setting a value can refuse a path it cannot write.
  field(pointer, segments, { throughLists = false } = {}) {
    let here = this.unwrap(pointer);
    let crossed = false;
    for (const segment of segments) {
      let next = this.child(here.pointer, segment);
      if (!next && throughLists && here.schema?.items && typeof here.schema.items === 'object' && !Array.isArray(here.schema.items)) {
        crossed = true;
        next = this.child(this.unwrap(`${here.pointer}/items`).pointer, segment);
      }
      if (!next) return null;
      here = next;
    }
    return { ...here, crossed };
  }

  // Every problem in one value, each with the path it was found at.
  // A failing `anyOf` or `oneOf` is reported through the branch closest to the value, found by validating the value against each branch on its own.
  // ajv reports every branch, which reads as contradictions: a job told both to add `uses` and to drop `steps`.
  validate(pointer, value, prefix, depth = 0) {
    const full = this.absolute(pointer).replace(/#$/, '');
    let check;
    try {
      check = this.ajv.getSchema(full);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(this.missing.length ? `the schema cannot be applied, ${this.missing.map(displayUri).join(', ')} could not be loaded (${reason})` : `the schema cannot be applied: ${reason}`);
    }
    if (!check) throw new Error(`cannot compile the schema at ${full}`);
    if (check(value)) return [];
    // A branch allowing null never explains anything, since the value is not null.
    let errors = (check.errors ?? []).filter((error) => !(error.keyword === 'type' && [].concat(error.params.type).join() === 'null'));
    const closest = [];
    const handled = [];
    const alternatives = errors.filter((error) => error.keyword === 'anyOf' || error.keyword === 'oneOf').sort((x, y) => x.instancePath.length - y.instancePath.length);
    for (const alternative of alternatives) {
      if (handled.some((path) => within(alternative.instancePath, path))) continue;
      const branches = depth < 8 ? this.branches(full.includes('#') ? full : `${full}#`, alternative, value) : null;
      if (!branches) continue;
      const here = `${prefix}${dotted(alternative.instancePath)}`;
      const results = branches.map((branch) => this.validate(branch.pointer, branch.value, here, depth + 1));
      // A oneOf failing because two branches pass is not a problem any branch can explain, so its own message is kept.
      if (results.some((result) => !result.length)) continue;
      // The closest branch is the one the value's own fields agree with most, so problems on the value itself count first, since a problem deeper down means the shape matched.
      // The total only breaks a tie, the way established validators rank their best match.
      // A branch of another type altogether, a string where the value is an object, is the furthest of all, whatever its count.
      const ranks = results.map((result, i) => [this.typeMatches(branches[i].pointer, branches[i].value) ? 0 : 1, result.filter((message) => message.startsWith(`${here}: `)).length, result.length]);
      const before = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
      const best = [...ranks].sort(before)[0];
      closest.push(...results.filter((_, i) => before(ranks[i], best) === 0).flat());
      handled.push(alternative.instancePath);
    }
    errors = errors.filter((error) => !handled.some((path) => within(error.instancePath, path)));
    return [...new Set([...formatErrors(errors, prefix), ...closest])];
  }

  // The branches of the alternative an error reports, each as the pointer to validate and the value it applies to, or null when the alternative cannot be located.
  branches(pointer, error, value) {
    const segments = error.instancePath.split('/').slice(1).map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    let here = this.unwrapRef(pointer);
    let data = value;
    for (const segment of segments) {
      const { schema } = this.at(here);
      if (Array.isArray(data)) {
        const index = Number(segment);
        if (Array.isArray(schema.prefixItems) && schema.prefixItems[index]) here = this.unwrapRef(`${here}/prefixItems/${index}`);
        else if (schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) here = this.unwrapRef(`${here}/items`);
        else return null;
        data = data[index];
        continue;
      }
      const next = this.childRef(here, segment);
      if (!next) return null;
      here = next;
      data = data?.[segment];
    }
    const options = this.at(here).schema?.[error.keyword];
    if (!Array.isArray(options)) return null;
    return options.flatMap((option, i) => (isNull(option) ? [] : [{ pointer: `${here}/${error.keyword}/${i}`, value: data }]));
  }

  // Whether a value is of a type the schema at a pointer allows, an integer counting as a number, and a schema naming no type allowing any.
  typeMatches(pointer, value) {
    const allowed = types(this.unwrap(pointer).schema);
    if (!allowed.length) return true;
    const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (actual === 'number') return allowed.includes('number') || (allowed.includes('integer') && Number.isInteger(value));
    return allowed.includes(actual);
  }

  // A reference followed, and nothing else, so an alternative a node holds is still there to see.
  unwrapRef(pointer, depth = 0) {
    if (depth > 32) throw new Error(`${pointer} references itself too deeply to follow`);
    const { schema, pointer: full } = this.at(pointer);
    if (!schema?.$ref) return full;
    const [uri] = splitPointer(full);
    const target = new URL(schema.$ref, this.bases.get(uri) ?? uri).href;
    return this.unwrapRef(target.includes('#') ? target : `${target}#`, depth + 1);
  }

  childRef(pointer, key) {
    const { schema } = this.at(pointer);
    if (schema?.properties && Object.hasOwn(schema.properties, key)) return this.unwrapRef(`${pointer}/properties/${escapeKey(key)}`);
    for (const pattern of Object.keys(schema?.patternProperties ?? {})) {
      if (new RegExp(pattern, 'u').test(key)) return this.unwrapRef(`${pointer}/patternProperties/${escapeKey(pattern)}`);
    }
    if (schema?.additionalProperties && typeof schema.additionalProperties === 'object') return this.unwrapRef(`${pointer}/additionalProperties`);
    return null;
  }
}

// A key as one segment of a JSON pointer, escaped the way RFC 6901 and a URI fragment both require.
export const escapeKey = (key) => encodeURIComponent(String(key).replace(/~/g, '~0').replace(/\//g, '~1'));

export function types(schema) {
  if (!schema) return [];
  if (schema.type) return [].concat(schema.type);
  if (schema.properties || schema.additionalProperties !== undefined) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

// A value from the command line, typed by what the schema says the field holds.
// A string field keeps the text exactly as typed: `005217217997` read as YAML would be a number without its leading zero, and `no` a boolean.
export function typedValue(schema, text) {
  if (schema.const !== undefined) return fromEnum([schema.const], text);
  if (schema.enum) return fromEnum(schema.enum, text);
  const allowed = types(schema).filter((type) => type !== 'null');
  if (!allowed.length || allowed.includes('string')) return text;
  if (text === 'null' && types(schema).includes('null')) return null;
  if (allowed.includes('boolean') && (text === 'true' || text === 'false')) return text === 'true';
  if ((allowed.includes('integer') || allowed.includes('number')) && text.trim() !== '' && !Number.isNaN(Number(text))) {
    const number = Number(text);
    if (allowed.includes('number') || Number.isInteger(number)) return number;
  }
  if (allowed.includes('array') || allowed.includes('object')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`expected ${allowed.join(' or ')} written as JSON, got ${text}`);
    }
  }
  throw new Error(`expected ${allowed.join(' or ')}, got ${text}`);
}

// An enum can hold a number or a boolean, and the text typed is matched against the value's own spelling so `3` finds `3` rather than `"3"`.
function fromEnum(values, text) {
  const found = values.find((value) => value !== null && String(value) === text);
  if (found !== undefined) return found;
  if (text === 'null' && values.includes(null)) return null;
  return text;
}

const within = (path, root) => path === root || path.startsWith(`${root}/`);
const dotted = (instancePath) => instancePath.replace(/\//g, '.').replace(/~1/g, '/').replace(/~0/g, '~');

function formatErrors(errors, prefix) {
  const seen = new Set();
  const out = [];
  for (const error of errors) {
    if (error.keyword === 'if') continue;
    const path = `${prefix}${dotted(error.instancePath)}`;
    const message = describe(error);
    const key = `${path} ${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`${path}: ${message}`);
  }
  return out;
}

function describe(error) {
  const { keyword, params } = error;
  if (keyword === 'additionalProperties') return `no such field ${params.additionalProperty}`;
  if (keyword === 'enum') return `must be one of ${params.allowedValues.filter((v) => v !== null).map((v) => JSON.stringify(v)).join(', ')}`;
  if (keyword === 'const') return `must be ${JSON.stringify(params.allowedValue)}`;
  if (keyword === 'required') return `missing required field ${params.missingProperty}`;
  if (keyword === 'type') return `must be ${[].concat(params.type).join(' or ')}`;
  // A pattern can hold a line break, which printed raw splits one message over two lines.
  if (keyword === 'pattern') return `must match the pattern ${JSON.stringify(params.pattern)}`;
  if (keyword === 'oneOf') return params.passingSchemas ? 'matches more than one of the alternatives, where exactly one is expected' : 'matches none of the alternatives';
  if (keyword === 'anyOf') return 'matches none of the alternatives';
  return error.message ?? keyword;
}
