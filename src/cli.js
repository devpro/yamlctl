// yamlctl <resource> <verb> [key] [field=value...], and the few verbs that take no resource.
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
  yamlctl <resource> list                          the entries, one line each
  yamlctl <resource> get <key>                     one entry, as YAML
  yamlctl <resource> set <key> <field>=<value>...  create the entry, or change the fields given and keep the others
  yamlctl <resource> set <key> --from <file>       create or replace the whole entry from a YAML or JSON file, - for standard input
  yamlctl <resource> delete <key>                  remove the entry
  yamlctl <resource> explain [field]               what the entries hold: fields, types, allowed values
  yamlctl <resource> check                         the file against its schema
  yamlctl resources                                every resource in the directory
  yamlctl check                                    every file in the directory against its schema

A resource is a file, project for project.yaml or project.yml, or a map of entries inside one, found in whichever file holds it.
A field inside an object is a path, risk_profile.business_impact, and a list or an object is written as JSON.
An empty value, description=, removes the field.

The schema is the one the file names on its first line,
  # yaml-language-server: $schema=schemas/project.schema.json
else schemas/<name>.schema.json, else <name>.schema.json beside the file.
A remote schema, and every remote $ref, is fetched and cached for a day in ${cacheDir()}.

Options:
  -C, --dir <dir>      the directory holding the data files (default: the current directory)
  -f, --file <file>    the data file, for a resource the directory does not name on its own
  -o, --output <fmt>   yaml or json for get and list, name for list
      --from <file>    the entry to set, - for standard input
      --force          accept a change the schema marks immutable
      --offline        read remote schemas from the cache only, never from the network
      --refresh        fetch remote schemas again even when the cache holds a recent copy
  -h, --help           this help
  -v, --version        the version

Examples:
  yamlctl project set checkout_api name="Checkout API" risk_profile.business_impact=HBI
  yamlctl project get checkout_api -o json
  yamlctl project get checkout_api | yamlctl project set checkout_web --from -
  yamlctl project explain risk_profile
`;

class UsageError extends Error {}

// Options may come anywhere, before or after the resource, so `yamlctl -C data project list` and `yamlctl project list -C data` read the same.
export function parseArgs(argv) {
  const options = { dir: '.', file: null, output: null, from: null, force: false, offline: false, refresh: false, help: false, version: false };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value`);
      return argv[++i];
    };
    if (arg === '-C' || arg === '--dir') options.dir = value();
    else if (arg === '-f' || arg === '--file') options.file = value();
    else if (arg === '-o' || arg === '--output') options.output = value();
    else if (arg === '--from') options.from = value();
    else if (arg === '--force') options.force = true;
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
// Only the files a command could read are looked at: the one -f names, else every data file of the directory.
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
  const uris = schemaUris(options.file ? [resolve(cwd, options.file)] : safeDataFiles(resolve(cwd, options.dir)));
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
    const dir = resolve(cwd, options.dir);
    const file = options.file ? resolve(cwd, options.file) : null;
    const context = { options, dir, file, out, err, stdin, cwd };

    if (words[0] === 'resources' && words.length === 1) return resources(context);
    if (words[0] === 'check' && words.length === 1) return checkDirectory(context);
    if (words.length < 2) throw new UsageError(`${words[0]} needs a verb: list, get, set, delete, explain or check`);

    const [name, verb, ...args] = words;
    const target = resolveResource({ dir, name, file });
    // A file naming a schema that cannot be loaded is not written: checking nothing where the file asked for a check is the one outcome worse than stopping.
    if (target.schemaError && (verb === 'set' || verb === 'delete')) throw new Error(`${display(target.file, cwd)} ${target.schemaError}, so it is not written`);
    if (target.schemaError) err(`warning: ${display(target.file, cwd)} ${target.schemaError}, so nothing is checked\n`);
    else if (!target.schema) err(`warning: no schema found for ${display(target.file, cwd)}, so nothing is checked\n`);
    const commands = { list, get, set, delete: remove, explain: explainCommand, check: checkResource };
    if (!Object.hasOwn(commands, verb)) throw new UsageError(`unknown verb ${verb}, use list, get, set, delete, explain or check`);
    return commands[verb]({ ...context, name, target, args });
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof UsageError) err(`Run yamlctl --help for the usage.\n`);
    return 1;
  }
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

function needKey(args, verb) {
  if (!args[0]) throw new UsageError(`${verb} needs the key of an entry`);
  return args[0];
}

function resources({ dir, out, cwd }) {
  const rows = listResources(dir).map((r) => [r.name, display(r.file, cwd), r.map ?? '-', r.entries ?? '-', r.error ? `error: ${r.error}` : r.schema ? display(r.schema, cwd) : '-']);
  out(table(['RESOURCE', 'FILE', 'MAP', 'ENTRIES', 'SCHEMA'], rows));
  return 0;
}

function list({ target, options, out }) {
  const maps = target.map ? [target.map] : target.maps;
  const data = target.document.data;
  if (options.output === 'json' || options.output === 'yaml') {
    const value = target.map ? (data[target.map] ?? {}) : Object.fromEntries(maps.map((map) => [map, data[map] ?? {}]));
    out(options.output === 'json' ? `${JSON.stringify(value, null, 2)}\n` : stringify(value, { lineWidth: 0 }));
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
  const key = needKey(args, 'get');
  const entries = target.document.data[map] ?? {};
  if (!Object.hasOwn(entries, key)) throw new Error(`no entry ${key} in ${map}`);
  // The entry alone, without its key, so it reads back through `set --from -` as it is.
  out(options.output === 'json' ? `${JSON.stringify(entries[key], null, 2)}\n` : stringify(entries[key], { lineWidth: 0 }));
  return 0;
}

function set({ target, name, args, options, out, err, stdin, cwd }) {
  const map = needMap(target, name);
  const key = needKey(args, 'set');
  const assignments = args.slice(1);
  const { document, schema } = target;
  const entries = document.data[map] ?? {};
  const exists = Object.hasOwn(entries, key);
  let entry;

  if (options.from) {
    if (assignments.length) throw new UsageError('set takes --from or <field>=<value>, not both');
    const text = options.from === '-' ? stdin() : readFileSync(resolve(cwd, options.from), 'utf8');
    entry = parse(text);
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${options.from === '-' ? 'standard input' : options.from} does not hold one entry`);
  } else {
    if (!assignments.length) throw new UsageError('set needs at least one <field>=<value>, or --from <file>');
    entry = structuredClone(exists && entries[key] && typeof entries[key] === 'object' ? entries[key] : {});
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
        if (parent[segment] === null || typeof parent[segment] !== 'object' || Array.isArray(parent[segment])) parent[segment] = {};
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
  }

  const problems = [];
  if (schema) problems.push(...schema.validate(schema.entryPointer(map), entry, `${map}/${key}`));
  problems.push(...checkSet({ schema, data: document.data, map, key, entry, force: options.force }).map((problem) => `${map}/${key}: ${problem}`));
  if (problems.length) {
    for (const problem of problems) err(`${problem}\n`);
    throw new Error(`${map}/${key} not written`);
  }

  if (exists && JSON.stringify(entries[key]) === JSON.stringify(entry)) {
    out(`${map}/${key} unchanged\n`);
    return 0;
  }
  setEntry(document, map, key, entry);
  writeDocument(document);
  out(`${map}/${key} ${exists ? 'updated' : 'created'}\n`);
  return 0;
}

// Without a schema a value is read the way YAML would read it, so a number or a list typed on the command line keeps its type.
function parseLoose(text) {
  try {
    return parse(text);
  } catch {
    return text;
  }
}

function remove({ target, name, args, out }) {
  const map = needMap(target, name);
  const key = needKey(args, 'delete');
  const { document, schema } = target;
  if (!Object.hasOwn(document.data[map] ?? {}, key)) {
    out(`${map}/${key} not found, nothing to delete\n`);
    return 0;
  }
  const referencing = referencesTo({ schema, data: document.data, map, key });
  if (referencing.length) throw new Error(`${map}/${key} is still named by ${referencing.join(', ')}: delete or change them first`);
  deleteEntry(document, map, key);
  writeDocument(document);
  out(`${map}/${key} deleted\n`);
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
