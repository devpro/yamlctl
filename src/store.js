// Every schema document a command can reach, by absolute URI: the file a data file names, and every document its `$ref`s lead to, local or remote.
//
// Remote documents are fetched before a command runs, by `prefetch`, so that everything after it reads from here and stays synchronous.
// A local document is read when used, since reading a file needs no preparation.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const documents = new Map();
const failures = new Map();

// A day, long enough that a pipeline running every few minutes does not download the same schema each time, short enough that a published fix arrives the next day.
export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

export const isRemote = (uri) => /^https?:\/\//i.test(uri);

export function cacheDir(env = process.env) {
  if (env.YAMLCTL_CACHE_DIR) return env.YAMLCTL_CACHE_DIR;
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'yamlctl');
}

// The document at a URI without its fragment, or an error saying why it is not there.
export function documentAt(uri) {
  if (documents.has(uri)) return documents.get(uri);
  if (uri.startsWith('file:')) {
    const path = fileURLToPath(uri);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new Error(`${path} is not a readable JSON Schema: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} does not hold a JSON Schema object`);
    // Read again every time rather than kept, since a schema file edited between two calls in one process has to be seen as edited.
    return parsed;
  }
  if (failures.has(uri)) throw new Error(failures.get(uri));
  throw new Error(`${uri} was not fetched`);
}

export function hasDocument(uri) {
  if (documents.has(uri)) return true;
  if (uri.startsWith('file:')) return existsSync(fileURLToPath(uri));
  return false;
}

// For a test, or a caller holding a schema that is not in a file.
export function registerDocument(uri, document) {
  documents.set(uri, document);
}

export function forget() {
  documents.clear();
  failures.clear();
}

// The URI a document's relative references resolve against: its own `$id` when it has one, as the specification says, else where it was read from.
// Resolving against where it was read from instead fetches the wrong document whenever a schema is published at one address and identified by another.
export function baseOf(document, uri) {
  const id = document?.$id ?? document?.id;
  if (typeof id !== 'string') return uri;
  try {
    return new URL(id, uri).href.replace(/#.*$/, '');
  } catch {
    return uri;
  }
}

// Every `$ref` in a document, resolved against the document it sits in, fragment dropped: the documents a validation of it can reach.
export function referencedDocuments(document, base) {
  const found = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) {
        try {
          found.add(new URL(value, base).href.replace(/#.*$/, ''));
        } catch {
          // A reference that is not a URL cannot be followed, and validation says so when it reaches it.
        }
      } else visit(value);
    }
  };
  visit(document);
  return [...found];
}

// Fetches every remote document reachable from the URIs given, following `$ref`s through local and remote documents alike, and keeps each one in the cache.
// A document the cache holds and that is younger than the TTL is not fetched again; `refresh` fetches regardless, `offline` never fetches.
// A fetch that fails falls back to a cached copy of any age, said in a warning.
// A document with no copy at all is recorded as a failure rather than thrown, so the command decides what an unavailable schema means for what it was asked to do.
export async function prefetch(uris, { offline = false, refresh = false, env = process.env, warn = () => {}, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const queue = [...uris];
  const seen = new Set();
  while (queue.length) {
    const uri = queue.shift();
    if (seen.has(uri)) continue;
    seen.add(uri);
    let document = null;
    if (isRemote(uri)) {
      document = await remoteDocument(uri, { offline, refresh, env, warn, fetchImpl, now });
      if (document) documents.set(uri, document);
    } else if (uri.startsWith('file:') && hasDocument(uri)) {
      try {
        document = documentAt(uri);
      } catch {
        document = null;
      }
    }
    if (document) queue.push(...referencedDocuments(document, baseOf(document, uri)));
  }
}

async function remoteDocument(uri, { offline, refresh, env, warn, fetchImpl, now }) {
  const cached = readCache(uri, env);
  if (offline) {
    if (cached) return cached.document;
    failures.set(uri, `${uri} is not in the cache, and --offline does not fetch it`);
    return null;
  }
  if (cached && !refresh && now - cached.fetchedAt < CACHE_TTL_MS) return cached.document;
  try {
    const response = await fetchImpl(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: 'application/schema+json, application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const document = JSON.parse(await response.text());
    if (document === null || typeof document !== 'object' || Array.isArray(document)) throw new Error('not a JSON Schema object');
    writeCache(uri, document, env);
    return document;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (cached) {
      warn(`${uri} could not be fetched (${reason}), using the copy cached ${age(now - cached.fetchedAt)} ago`);
      return cached.document;
    }
    failures.set(uri, `${uri} could not be fetched: ${reason}`);
    return null;
  }
}

function cacheFile(uri, env) {
  return join(cacheDir(env), `${createHash('sha256').update(uri).digest('hex')}.json`);
}

function readCache(uri, env) {
  const file = cacheFile(uri, env);
  if (!existsSync(file)) return null;
  try {
    const { url, document } = JSON.parse(readFileSync(file, 'utf8'));
    if (url !== uri) return null;
    return { document, fetchedAt: statSync(file).mtimeMs };
  } catch {
    // A cache entry that does not parse is one to fetch again, not a reason to stop.
    return null;
  }
}

function writeCache(uri, document, env) {
  try {
    mkdirSync(cacheDir(env), { recursive: true });
    writeFileSync(cacheFile(uri, env), JSON.stringify({ url: uri, document }));
  } catch {
    // A cache that cannot be written only costs a fetch next time.
  }
}

function age(ms) {
  const hours = Math.round(ms / 3600000);
  return hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${Math.round(hours / 24)} days`;
}
