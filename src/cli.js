// yamlctl <resource> <verb> [key] [field=value...] or -f <file>, and the few verbs that take no resource.
//
// The grammar is noun then verb, `yamlctl project list`, so every verb a resource has sits beside the others in the help and a new one lands in the same place.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';
import { deleteEntry, setEntry, writeDocument } from './document.js';
import { explain } from './explain.js';
import { dataFiles, listResources, openFile, resolveResource } from './resources.js';
import { checkAll, checkSet, referencesTo } from './rules.js';
import { SCHEMA_LINE, typedValue } from './schema.js';
import { cacheDir, isRemote, prefetch } from './store.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `yamlctl reads and edits YAML data files entry by entry, every change checked against the file's JSON Schema.

Usage:
  yamlctl <resource> list                              the entries, one line each
  yamlctl <resource> get <key>...                      the entries under their keys, as YAML
  yamlctl <resource> create <key> <field>=<value>...   a new entry, refused if the key is taken
  yamlctl <resource> create -f <file>                  every entry of the file, refused if a key is taken
  yamlctl <resource> apply <key> <field>=<value>...    create the entry, or change the fields given and keep the others
  yamlctl <resource> apply -f <file>                   create each entry of the file, or merge it into the one there
  yamlctl <resource> patch <key> <field>=<value>...    change the fields given of an existing entry, keep the others
  yamlctl <resource> replace -f <file>                 replace each entry of the file whole, refused if one is missing
  yamlctl <resource> delete <key>...                   remove the entries
  yamlctl <resource> delete -f <file>                  remove the entries the file names
  yamlctl <resource> explain [field]                   what the entries hold: fields, types, allowed values
  yamlctl <resource> check                             the file against its schema
  yamlctl resources                                    every resource in the directory
  yamlctl check                                        every file in the directory against its schema

A resource is a file, project for project.yaml or project.yml, or a map of entries inside one, found in whichever file holds it.
A field inside an object is a path, risk_profile.business_impact, and a list or an object is written as JSON.
An empty value, description=, removes the field.

A file given with -f holds entries under their keys, the shape get and list -o yaml print, as YAML or JSON.
apply -f merges each one into the entry already there: an object merges, a list replaces, and null removes the field.

The schema is the one the file names on its first line,
  # yaml-language-server: $schema=schemas/project.schema.json
else schemas/<name>.schema.json, else <name>.schema.json beside the file.
A remote schema, and every remote $ref, is fetched and cached for a day in ${cacheDir()}.

Options:
  -C, --dir <dir>         the directory holding the data files (default: the current directory)
      --data-file <file>  the data file, for a resource the directory does not name on its own
  -o, --output <fmt>      yaml, json or name, for a pipeline: the entries, or their resource paths, instead of a table or a sentence
  -f, --filename <file>   the entries to create, apply, replace or delete, - for standard input
      --force             accept a change the schema marks immutable
      --ignore-not-found  delete succeeds without a word when the entry is not there
      --prune             apply -f also deletes the entries the file does not hold, within --prefix or --all
      --prefix <prefix>   the keys --prune may delete, the ones a sync owns
      --all               --prune may delete any entry of the map
      --offline           read remote schemas from the cache only, never from the network
      --refresh           fetch remote schemas again even when the cache holds a recent copy
  -h, --help              this help
  -v, --version           the version

Examples:
  yamlctl project create checkout_api name="Checkout API" risk_profile.business_impact=HBI
  yamlctl project patch checkout_api risk_profile.business_impact=MBI
  yamlctl project get checkout_api -o json
  yamlctl project list -o yaml > projects.yaml && yamlctl project apply -f projects.yaml
  yamlctl project explain risk_profile
`;

class UsageError extends Error {}

// The verbs writing an entry, named and behaving as kubectl's do, so someone who knows one knows the other.
// `exists` is what the entry must be beforehand, `fields` and `filename` the input each takes, and `done` what the output says.
const WRITES = {
  create: { exists: false, fields: true, filename: true, done: () => 'created' },
  apply: { exists: null, fields: true, filename: true, done: (existed, changed) => (!existed ? 'created' : changed ? 'configured' : 'unchanged') },
  patch: { exists: true, fields: true, filename: false, done: (existed, changed) => (changed ? 'patched' : 'patched (no change)') },
  replace: { exists: true, fields: false, filename: true, done: (existed, changed) => (changed ? 'replaced' : 'replaced (no change)') },
};
const VERBS = 'list, get, create, apply, patch, replace, delete, explain or check';

// Options may come anywhere, before or after the resource, so `yamlctl -C data project list` and `yamlctl project list -C data` read the same.
export function parseArgs(argv) {
  const options = { dir: '.', dataFile: null, output: null, filename: null, force: false, ignoreNotFound: false, prune: false, all: false, prefix: null, offline: false, refresh: false, help: false, version: false };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '-C' || arg === '--dir') options.dir = value();
    else if (arg === '--data-file') options.dataFile = value();
    else if (arg === '-o' || arg === '--output') options.output = value();
    else if (arg === '-f' || arg === '--filename') options.filename = value();
    else if (arg === '--force') options.force = true;
    else if (arg === '--ignore-not-found') options.ignoreNotFound = true;
    else if (arg === '--prune') options.prune = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--prefix') options.prefix = value();
    else if (arg === '--offline') options.offline = true;
    else if (arg === '--refresh') options.refresh = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '-v' || arg === '--version') options.version = true;
    else if (arg.startsWith('--') && arg.includes('=')) {
      const [flag, ...rest] = arg.split('=');
      argv.splice(i + 1, 0, rest.join('='));
      argv[i] = flag;
      i--;
    } else if (arg.startsWith('-') && arg !== '-' && !arg.includes('=')) throw new UsageError(`unknown option ${arg}`);
    else words.push(arg);
  }
  if (options.output && !['yaml', 'json', 'name'].includes(options.output)) throw new UsageError(`-o takes yaml, json or name, not ${options.output}`);
  return { options, words };
}

// The schemas the command can reach are fetched first, the only step needing the network, so everything after it runs synchronously from what was fetched.
// Only the files a command could read are looked at: the one --data-file names, else every data file of the directory.
export async function main(argv, io = {}) {
  const err = io.err ?? ((text) => process.stderr.write(text));
  const cwd = io.cwd ?? process.cwd();
  const env = io.env ?? process.env;
  let parsed;
  try {
    parsed = parseArgs([...argv]);
  } catch {
    return run(argv, io);
  }
  const { options } = parsed;
  const uris = schemaUris(options.dataFile ? [resolve(cwd, options.dataFile)] : safeDataFiles(resolve(cwd, options.dir)));
  if (uris.length) {
    await prefetch(uris, {
      offline: options.offline || env.YAMLCTL_OFFLINE === '1',
      refresh: options.refresh,
      env,
      warn: (text) => err(`warning: ${text}\n`),
      fetchImpl: io.fetch ?? globalThis.fetch,
    });
  }
  return run(argv, io);
}

function safeDataFiles(dir) {
  try {
    return dataFiles(dir);
  } catch {
    return [];
  }
}

// The schema each file names, as the URI the store fetches or reads, a local one included since its own `$ref`s may lead onto the network.
function schemaUris(files) {
  const uris = new Set();
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const named = text.match(SCHEMA_LINE)?.[1];
    if (!named) continue;
    if (isRemote(named)) uris.add(named);
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(named)) {
      const path = isAbsolute(named) ? named : join(dirname(file), named);
      if (existsSync(path)) uris.add(pathToFileURL(path).href);
    }
  }
  return [...uris];
}

// Everything a command prints goes through `out` and `err`, and the return value is the exit status, so a test runs a command without a child process.
export function run(argv, { out = (text) => process.stdout.write(text), err = (text) => process.stderr.write(text), stdin = () => readFileSync(0, 'utf8'), cwd = process.cwd() } = {}) {
  try {
    const { options, words } = parseArgs([...argv]);
    if (options.version) {
      out(`${VERSION}\n`);
      return 0;
    }
    if (options.help || !words.length || words[0] === 'help') {
      out(HELP);
      return 0;
    }
    checkPrune(options, words[1]);
    const dir = resolve(cwd, options.dir);
    const file = options.dataFile ? resolve(cwd, options.dataFile) : null;
    const context = { options, dir, file, out, err, stdin, cwd };

    if (words[0] === 'resources' && words.length === 1) return resources(context);
    if (words[0] === 'check' && words.length === 1) return checkDirectory(needNoOutput(context, 'check'));
    if (words.length < 2) throw new UsageError(`${words[0]} needs a verb: ${VERBS}`);

    const [name, verb, ...args] = words;
    const target = resolveResource({ dir, name, file });
    // A file naming a schema that cannot be loaded is not written: checking nothing where the file asked for a check is the one outcome worse than stopping.
    if (target.schemaError && (Object.hasOwn(WRITES, verb) || verb === 'delete')) throw new Error(`${display(target.file, cwd)} ${target.schemaError}, so it is not written`);
    if (target.schemaError) err(`warning: ${display(target.file, cwd)} ${target.schemaError}, so nothing is checked\n`);
    else if (!target.schema) err(`warning: no schema found for ${display(target.file, cwd)}, so nothing is checked\n`);
    if (Object.hasOwn(WRITES, verb)) return write(verb, { ...context, name, target, args });
    const commands = { list, get, delete: remove, explain: (c) => explainCommand(needNoOutput(c, 'explain')), check: (c) => checkResource(needNoOutput(c, 'check')) };
    if (!Object.hasOwn(commands, verb)) throw new UsageError(`unknown verb ${verb}, use ${VERBS}`);
    return commands[verb]({ ...context, name, target, args });
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof UsageError) err(`Run yamlctl --help for the usage.\n`);
    return 1;
  }
}

// Pruning deletes what the file does not hold, so it is refused without a scope saying which entries it may delete, as kubectl refuses it without a selector or --all.
function checkPrune(options, verb) {
  if (!options.prune) {
    if (options.prefix !== null || options.all) throw new UsageError('--prefix and --all work with --prune only');
    return;
  }
  if (verb !== 'apply' || !options.filename) throw new UsageError('--prune works with apply -f only');
  if (options.prefix !== null && options.all) throw new UsageError('--prune takes --prefix <prefix> or --all, not both');
  if (options.prefix === '') throw new UsageError('--prefix needs a prefix, --all prunes every entry');
  if (options.prefix === null && !options.all) throw new UsageError('--prune needs --prefix <prefix> or --all, the entries it may delete');
}

function needNoOutput(context, verb) {
  if (context.options.output) throw new UsageError(verb === 'check' ? 'check takes no -o, its exit status is the result' : `${verb} takes no -o`);
  return context;
}

// A path relative to where the command runs, an address as it is.
const display = (path, cwd) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) return path;
  const rel = relative(cwd, path);
  return rel.startsWith('..') ? path : rel || basename(path);
};

// The one map a verb acting on an entry needs, refused with the names to use when the resource is a file holding several.
function needMap(target, name) {
  if (target.map) return target.map;
  if (!target.maps.length) throw new Error(`${basename(target.file)} holds no map of entries`);
  throw new Error(`${basename(target.file)} holds several maps, use one as the resource: ${target.maps.map((map) => `yamlctl ${map} ...`).join(', ')}`);
}

function needKey(args, verb, orFile = false) {
  if (!args[0]) throw new UsageError(`${verb} needs the key of an entry${orFile ? ', or -f <file>' : ''}`);
  return args[0];
}

function printData(value, format, out) {
  out(format === 'json' ? `${JSON.stringify(value, null, 2)}\n` : stringify(value, { lineWidth: 0 }));
}

function resources({ dir, options, out, cwd }) {
  const found = listResources(dir);
  if (options.output === 'name') {
    for (const r of found) out(`${r.name}\n`);
    return 0;
  }
  if (options.output) {
    printData(found.map((r) => ({ ...r, file: display(r.file, cwd), schema: r.schema ? display(r.schema, cwd) : null })), options.output, out);
    return 0;
  }
  const rows = found.map((r) => [r.name, display(r.file, cwd), r.map ?? '-', r.entries ?? '-', r.error ? `error: ${r.error}` : r.schema ? display(r.schema, cwd) : '-']);
  out(table(['RESOURCE', 'FILE', 'MAP', 'ENTRIES', 'SCHEMA'], rows));
  return 0;
}

function list({ target, options, out }) {
  const maps = target.map ? [target.map] : target.maps;
  const data = target.document.data;
  if (options.output === 'json' || options.output === 'yaml') {
    const value = target.map ? (data[target.map] ?? {}) : Object.fromEntries(maps.map((map) => [map, data[map] ?? {}]));
    printData(value, options.output, out);
    return 0;
  }
  for (const map of maps) {
    const entries = Object.entries(data[map] ?? {});
    if (options.output === 'name') {
      for (const [key] of entries) out(`${map}/${key}\n`);
      continue;
    }
    if (maps.length > 1) out(`${map}:\n`);
    const titleField = target.schema?.mapOptions(map).title ?? 'name';
    const titled = entries.some(([, entry]) => entry && typeof entry[titleField] === 'string');
    const header = titled ? ['KEY', titleField.toUpperCase()] : ['KEY'];
    const rows = entries.map(([key, entry]) => (titled ? [key, entry?.[titleField] ?? ''] : [key]));
    out(rows.length ? table(header, rows, maps.length > 1 ? '  ' : '') : `${maps.length > 1 ? '  ' : ''}no entries\n`);
  }
  return 0;
}

function get({ target, name, args, options, out }) {
  const map = needMap(target, name);
  needKey(args, 'get');
  const entries = target.document.data[map] ?? {};
  const found = {};
  for (const key of args) {
    if (!Object.hasOwn(entries, key)) throw new Error(`no entry ${key} in ${map}`);
    found[key] = entries[key];
  }
  // Under their keys, the shape -f reads, so what get prints goes back through apply or replace as it is.
  if (options.output === 'name') for (const key of Object.keys(found)) out(`${map}/${key}\n`);
  else printData(found, options.output === 'json' ? 'json' : 'yaml', out);
  return 0;
}

const REPLACE_USAGE = 'replace takes -f <file> only, patch takes <key> <field>=<value>...';

// Every entry the command writes is checked against the file as it will be, and the file is written once, or not at all when one of them fails.
function write(verb, context) {
  const { target, name, args, options, out, err, cwd } = context;
  const rules = WRITES[verb];
  const map = needMap(target, name);
  const { document, schema } = target;
  const entries = document.data[map] ?? {};
  let changes;

  if (options.filename) {
    if (!rules.filename) throw new UsageError('patch takes <key> <field>=<value>..., replace takes -f <file>');
    if (args.length) throw new UsageError(verb === 'replace' ? REPLACE_USAGE : `${verb} takes -f <file> without a key`);
    const given = readEntries(options.filename, context);
    changes = Object.entries(given).map(([key, entry]) => ({ key, entry: verb === 'apply' ? mergePatch(entries[key], entry) : entry }));
  } else {
    if (!rules.fields) throw new UsageError(REPLACE_USAGE);
    const key = needKey(args, verb, rules.filename);
    const assignments = args.slice(1);
    if (!assignments.length) throw new UsageError(`${verb} needs at least one <field>=<value>${rules.filename ? ', or -f <file>' : ''}`);
    const base = isObject(entries[key]) ? entries[key] : {};
    changes = [{ key, entry: assign(structuredClone(base), assignments, { schema, map, name }) }];
  }

  for (const { key } of changes) {
    const exists = Object.hasOwn(entries, key);
    if (rules.exists === false && exists) throw new Error(`${map}/${key} already exists, use apply, patch or replace to change it`);
    if (rules.exists === true && !exists) throw new Error(`no entry ${key} in ${map}`);
  }

  const next = { ...document.data, [map]: { ...entries } };
  for (const { key, entry } of changes) next[map][key] = entry;
  let pruned = [];
  if (options.prune) {
    const owned = (key) => options.all || key.startsWith(options.prefix);
    const outside = changes.find(({ key }) => !owned(key));
    if (outside) throw new Error(`${options.filename === '-' ? 'standard input' : options.filename} holds ${outside.key}, outside the prefix ${options.prefix} it prunes`);
    pruned = Object.keys(entries).filter((key) => owned(key) && !changes.some((change) => change.key === key));
    for (const key of pruned) delete next[map][key];
  }
  const problems = [];
  for (const { key, entry } of changes) {
    if (schema) problems.push(...schema.validate(schema.entryPointer(map), entry, `${map}/${key}`));
    problems.push(...checkSet({ schema, data: next, previous: document.data, map, key, entry, force: options.force }).map((problem) => `${map}/${key}: ${problem}`));
  }
  if (problems.length) {
    for (const problem of problems) err(`${problem}\n`);
    throw new Error(`${options.filename ? display(target.file, cwd) : `${map}/${changes[0].key}`} not written`);
  }
  for (const key of pruned) {
    const referencing = referencesTo({ schema, data: next, map, key });
    if (referencing.length) throw new Error(`${map}/${key} is still named by ${referencing.join(', ')}: delete or change them first`);
  }

  const lines = [];
  for (const { key, entry } of changes) {
    const existed = Object.hasOwn(entries, key);
    const changed = !existed || !sameData(entries[key], entry);
    if (changed) setEntry(document, map, key, entry);
    lines.push(`${map}/${key} ${rules.done(existed, changed)}\n`);
  }
  for (const key of pruned) {
    deleteEntry(document, map, key);
    lines.push(`${map}/${key} pruned\n`);
  }
  writeDocument(document);
  // A pipeline reads the entries or their paths rather than a sentence, and -o name keeps the entries pruned, since they are part of what was done.
  if (options.output === 'name') for (const key of [...changes.map((change) => change.key), ...pruned]) out(`${map}/${key}\n`);
  else if (options.output) printData(Object.fromEntries(changes.map(({ key, entry }) => [key, entry])), options.output, out);
  else for (const line of lines) out(line);
  return 0;
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Equal whatever the order of the fields, since an entry read from a file lists them in whatever order its author chose.
function sameData(a, b) {
  const canonical = (value) => (Array.isArray(value) ? value.map(canonical) : isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value);
  return JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));
}

// A JSON merge patch, RFC 7386, which is what apply -f does to an entry, as kubectl apply does to an object:
// an object merges into the one it meets, anything else replaces what it meets, a list included, and null removes the field.
function mergePatch(target, patch) {
  if (!isObject(patch)) return patch;
  const result = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

// The entries an -f file holds by key, the shape get and list -o yaml print, each one an object.
function readEntries(filename, { stdin, cwd }) {
  const source = filename === '-' ? 'standard input' : filename;
  let text;
  if (filename === '-') text = stdin();
  else {
    try {
      text = readFileSync(resolve(cwd, filename), 'utf8');
    } catch (e) {
      throw new Error(`cannot read ${filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  let entries;
  try {
    entries = parse(text);
  } catch (e) {
    throw new Error(`${source} is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (entries === null || entries === undefined) throw new Error(`${source} holds no entries`);
  if (!isObject(entries)) throw new Error(`${source} does not hold entries by key`);
  if (!Object.keys(entries).length) throw new Error(`${source} holds no entries`);
  for (const [key, entry] of Object.entries(entries)) {
    if (!isObject(entry)) throw new Error(`${source}: ${key} is not an entry`);
  }
  return entries;
}

// The <field>=<value> assignments written into an entry, each value typed by the schema.
function assign(entry, assignments, { schema, map, name }) {
  const entryPointer = schema?.entryPointer(map);
  for (const assignment of assignments) {
    const at = assignment.indexOf('=');
    if (at < 1) throw new UsageError(`${assignment} is not <field>=<value>`);
    const path = assignment.slice(0, at);
    const text = assignment.slice(at + 1);
    const segments = path.split('.');
    if (segments.some((segment) => segment === '')) throw new UsageError(`${path} is not a field path`);
    const field = schema ? schema.field(entryPointer, segments) : null;
    if (schema && !field) {
      if (schema.field(entryPointer, segments, { throughLists: true })) throw new Error(`${path}: goes into a list, which is set whole as JSON: ${segments[0]}='[...]'`);
      throw new Error(`${path}: no such field in ${map}, run yamlctl ${name} explain to list them`);
    }
    let parent = entry;
    for (const segment of segments.slice(0, -1)) {
      if (!isObject(parent[segment])) parent[segment] = {};
      parent = parent[segment];
    }
    const last = segments.at(-1);
    if (text === '') {
      delete parent[last];
      continue;
    }
    try {
      parent[last] = field ? typedValue(field.schema, text) : parseLoose(text);
    } catch (e) {
      throw new Error(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return entry;
}

// Without a schema a value is read the way YAML would read it, so a number or a list typed on the command line keeps its type.
function parseLoose(text) {
  try {
    return parse(text);
  } catch {
    return text;
  }
}

function remove(context) {
  const { target, name, args, options, out } = context;
  if (options.output && options.output !== 'name') throw new UsageError('delete takes -o name only');
  const map = needMap(target, name);
  let keys;
  if (options.filename) {
    if (args.length) throw new UsageError('delete takes -f <file> without a key');
    keys = Object.keys(readEntries(options.filename, context));
  } else {
    needKey(args, 'delete', true);
    keys = [...new Set(args)];
  }
  const { document, schema } = target;
  const entries = document.data[map] ?? {};
  const present = [];
  for (const key of keys) {
    if (Object.hasOwn(entries, key)) present.push(key);
    else if (!options.ignoreNotFound) throw new Error(`no entry ${key} in ${map}`);
  }
  // Checked against the file as it will be, so an entry deleted along with every entry naming it is not refused.
  const next = { ...document.data, [map]: Object.fromEntries(Object.entries(entries).filter(([key]) => !present.includes(key))) };
  for (const key of present) {
    const referencing = referencesTo({ schema, data: next, map, key });
    if (referencing.length) throw new Error(`${map}/${key} is still named by ${referencing.join(', ')}: delete or change them first`);
  }
  for (const key of present) deleteEntry(document, map, key);
  writeDocument(document);
  for (const key of present) out(options.output === 'name' ? `${map}/${key}\n` : `${map}/${key} deleted\n`);
  return 0;
}

function explainCommand({ target, name, args, out }) {
  const map = needMap(target, name);
  if (!target.schema) throw new Error(`${basename(target.file)} has no schema to explain`);
  out(explain(target.schema, map, args[0] ? args[0].split('.') : []));
  return 0;
}

function problemsOf(opened) {
  if (!opened.schema) return [];
  const data = opened.document.data;
  const problems = opened.schema.validate('#', data, basename(opened.file));
  problems.push(...checkAll({ schema: opened.schema, data }).map((problem) => `${basename(opened.file)}: ${problem}`));
  return problems;
}

function report(opened, { out, err, cwd }) {
  const where = display(opened.file, cwd);
  if (opened.schemaError) {
    err(`${where} ${opened.schemaError}\n`);
    return false;
  }
  if (!opened.schema) {
    out(`${where}: no schema, not checked\n`);
    return true;
  }
  const problems = problemsOf(opened);
  for (const problem of problems) err(`${problem}\n`);
  const entries = opened.maps.reduce((total, map) => total + Object.keys(opened.document.data[map] ?? {}).length, 0);
  if (!problems.length) out(opened.maps.length ? `${where}: ${entries} ${entries === 1 ? 'entry' : 'entries'}, valid\n` : `${where}: valid\n`);
  return !problems.length;
}

function checkResource(context) {
  return report(context.target, context) ? 0 : 1;
}

function checkDirectory(context) {
  let ok = true;
  const files = context.file ? [context.file] : dataFiles(context.dir);
  for (const path of files) {
    let opened;
    try {
      opened = openFile(path);
    } catch (e) {
      context.err(`${display(path, context.cwd)}: ${e instanceof Error ? e.message : String(e)}\n`);
      ok = false;
      continue;
    }
    if (!report(opened, context)) ok = false;
  }
  return ok ? 0 : 1;
}

function table(header, rows, indent = '') {
  const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => String(row[i]).length)));
  const line = (cells) => `${indent}${cells.map((cell, i) => (i === cells.length - 1 ? String(cell) : String(cell).padEnd(widths[i]))).join('   ')}`.trimEnd();
  return `${[header, ...rows].map(line).join('\n')}\n`;
}
