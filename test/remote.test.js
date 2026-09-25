import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { forget } from '../src/store.js';
import { emptyDir, read, write } from './helpers.js';

// A real server rather than a stubbed fetch, so the requests counted are the ones the command actually makes over HTTP.
const served = new Map();
const hits = new Map();
let server;
let base;

before(async () => {
  server = createServer((request, response) => {
    hits.set(request.url, (hits.get(request.url) ?? 0) + 1);
    const body = served.get(request.url);
    if (body === undefined) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

beforeEach(() => {
  served.clear();
  hits.clear();
  // Fetched documents are kept for the life of the process, which is one command in real use and every test here.
  forget();
});

const project = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    projects: { type: 'object', additionalProperties: { $ref: 'definitions.json#/project' } },
  },
};
const definitions = {
  project: {
    type: 'object',
    additionalProperties: false,
    properties: {
      name: { type: 'string', description: 'Display name, from the second document.' },
      impact: { enum: ['LBI', 'MBI', 'HBI'] },
    },
  },
};

function serveProject() {
  served.set('/schemas/project.json', project);
  served.set('/schemas/definitions.json', definitions);
}

// A workspace whose data file names a schema on the test server, and a cache of its own.
function remoteWorkspace(path = '/schemas/project.json') {
  const dir = emptyDir();
  write(dir, 'project.yaml', `# yaml-language-server: $schema=${base}${path}\nprojects:\n  one:\n    name: One\n`);
  return { dir, env: { YAMLCTL_CACHE_DIR: join(dir, '.cache') } };
}

async function cli(dir, args, env) {
  let out = '';
  let err = '';
  const code = await main(args, { cwd: dir, env, out: (text) => (out += text), err: (text) => (err += text) });
  // Each command in real use is its own process, with nothing fetched kept in memory from the one before.
  forget();
  return { code, out, err };
}

test('a remote schema and the remote document its $ref leads to are fetched and applied', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  assert.deepEqual(await cli(dir, ['project', 'set', 'two', 'name=Two', 'impact=HBI'], env), { code: 0, out: 'projects/two created\n', err: '' });
  const refused = await cli(dir, ['project', 'set', 'two', 'impact=HIGH'], env);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /projects\/two\.impact: must be one of "LBI", "MBI", "HBI"/);
  assert.match((await cli(dir, ['project', 'set', 'two', 'nme=x'], env)).err, /nme: no such field in projects/);
});

test('explain reads across the remote documents', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  assert.match((await cli(dir, ['project', 'explain', 'name'], env)).out, /DESCRIPTION:\n {2}Display name, from the second document\./);
});

test('a fetched schema is cached, so the next command within a day makes no request', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  await cli(dir, ['project', 'list'], env);
  assert.equal(hits.get('/schemas/project.json'), 1);
  assert.equal(hits.get('/schemas/definitions.json'), 1);
  await cli(dir, ['project', 'set', 'two', 'name=Two'], env);
  await cli(dir, ['check'], env);
  assert.equal(hits.get('/schemas/project.json'), 1);
  assert.equal(hits.get('/schemas/definitions.json'), 1);
  assert.equal(readdirSync(env.YAMLCTL_CACHE_DIR).filter((name) => name.endsWith('.json')).length, 2);
});

test('--refresh fetches again even when the cache is recent', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  await cli(dir, ['project', 'list'], env);
  await cli(dir, ['project', 'list', '--refresh'], env);
  assert.equal(hits.get('/schemas/project.json'), 2);
});

test('a cached copy older than a day is fetched again', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  await cli(dir, ['project', 'list'], env);
  ageCache(env, 2);
  await cli(dir, ['project', 'list'], env);
  assert.equal(hits.get('/schemas/project.json'), 2);
});

test('--offline reads the cache and never the network', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  await cli(dir, ['project', 'list'], env);
  served.clear();
  ageCache(env, 30);
  assert.deepEqual(await cli(dir, ['project', 'set', 'two', 'name=Two', '--offline'], env), { code: 0, out: 'projects/two created\n', err: '' });
  assert.equal(hits.get('/schemas/project.json'), 1);
});

test('YAMLCTL_OFFLINE=1 is the same as --offline', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  await cli(dir, ['project', 'list'], env);
  await cli(dir, ['project', 'list'], { ...env, YAMLCTL_OFFLINE: '1' });
  assert.equal(hits.get('/schemas/project.json'), 1);
});

test('--offline with nothing cached refuses a write and names what is missing', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  const before = read(dir, 'project.yaml');
  const { code, err } = await cli(dir, ['project', 'set', 'two', 'name=Two', '--offline'], env);
  assert.equal(code, 1);
  assert.match(err, /project\.json is not in the cache, and --offline does not fetch it, so it is not written/);
  assert.equal(read(dir, 'project.yaml'), before);
  assert.equal(hits.get('/schemas/project.json'), undefined);
});

test('a server that cannot be reached falls back to the cached copy, with a warning', async () => {
  serveProject();
  const { dir, env } = remoteWorkspace();
  await cli(dir, ['project', 'list'], env);
  served.clear();
  ageCache(env, 3);
  const { code, out, err } = await cli(dir, ['project', 'set', 'two', 'name=Two'], env);
  assert.equal(code, 0, err);
  assert.equal(out, 'projects/two created\n');
  assert.match(err, /warning: http:\/\/127\.0\.0\.1:\d+\/schemas\/project\.json could not be fetched \(HTTP 404\), using the copy cached 3 days ago/);
});

test('a schema that cannot be fetched and was never cached blocks a write, and a read only warns', async () => {
  const { dir, env } = remoteWorkspace('/schemas/missing.json');
  const refused = await cli(dir, ['project', 'set', 'two', 'name=Two'], env);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /missing\.json could not be fetched: HTTP 404, so it is not written/);
  const listed = await cli(dir, ['project', 'list'], env);
  assert.equal(listed.code, 0);
  assert.match(listed.err, /warning: .*missing\.json could not be fetched: HTTP 404, so nothing is checked/);
  assert.match(listed.out, /one/);
});

test('a missing document behind a $ref makes the schema unusable rather than half applied', async () => {
  served.set('/schemas/project.json', project);
  const { dir, env } = remoteWorkspace();
  const { code, err } = await cli(dir, ['project', 'set', 'two', 'name=Two'], env);
  assert.equal(code, 1);
  assert.match(err, /definitions\.json/);
  assert.equal(read(dir, 'project.yaml').includes('two'), false);
});

test('a response that is not JSON is a failed fetch, not a schema', async () => {
  served.set('/schemas/project.json', '<html>login</html>');
  const { dir, env } = remoteWorkspace();
  assert.match((await cli(dir, ['project', 'set', 'two', 'name=Two'], env)).err, /project\.json could not be fetched: .*JSON/);
});

test('a local schema whose $ref leads onto the network has that document fetched', async () => {
  served.set('/schemas/definitions.json', definitions);
  const dir = emptyDir();
  const env = { YAMLCTL_CACHE_DIR: join(dir, '.cache') };
  write(dir, 'schema.json', JSON.stringify({ type: 'object', properties: { projects: { type: 'object', additionalProperties: { $ref: `${base}/schemas/definitions.json#/project` } } } }));
  write(dir, 'project.yaml', '# yaml-language-server: $schema=schema.json\nprojects: {}\n');
  assert.deepEqual(await cli(dir, ['project', 'set', 'one', 'name=One', 'impact=LBI'], env), { code: 0, out: 'projects/one created\n', err: '' });
  assert.match((await cli(dir, ['project', 'set', 'one', 'impact=X'], env)).err, /must be one of "LBI", "MBI", "HBI"/);
  assert.equal(hits.get('/schemas/definitions.json'), 1);
});

test('a schema split over local files is followed with no network at all', async () => {
  const dir = emptyDir();
  const env = { YAMLCTL_CACHE_DIR: join(dir, '.cache') };
  write(dir, 'project.schema.json', JSON.stringify({ ...project, properties: { projects: { type: 'object', additionalProperties: { $ref: 'defs/definitions.json#/project' } } } }));
  write(dir, 'defs/definitions.json', JSON.stringify(definitions));
  write(dir, 'project.yaml', '# yaml-language-server: $schema=project.schema.json\nprojects: {}\n');
  assert.equal((await cli(dir, ['project', 'set', 'one', 'name=One'], env)).code, 0);
  assert.match((await cli(dir, ['project', 'set', 'one', 'impact=X'], env)).err, /must be one of "LBI", "MBI", "HBI"/);
  assert.match((await cli(dir, ['project', 'explain', 'name'], env)).out, /Display name, from the second document\./);
  assert.equal(existsSync(env.YAMLCTL_CACHE_DIR), false);
});

test('a relative $ref resolves against the document $id, as the specification says', async () => {
  served.set('/published/project.json', { ...project, $id: `${base}/canonical/project.json` });
  served.set('/canonical/definitions.json', definitions);
  const { dir, env } = remoteWorkspace('/published/project.json');
  const result = await cli(dir, ['project', 'set', 'two', 'name=Two'], env);
  assert.equal(result.code, 0, result.err);
  assert.equal(hits.get('/canonical/definitions.json'), 1);
  assert.equal(hits.get('/published/definitions.json'), undefined);
});

test('nothing is fetched when no file names a remote schema', async () => {
  const dir = emptyDir();
  write(dir, 'servers.yaml', 'servers:\n  web:\n    port: 80\n');
  let fetched = 0;
  const code = await main(['servers', 'list'], { cwd: dir, env: {}, out: () => {}, err: () => {}, fetch: () => fetched++ });
  assert.equal(code, 0);
  assert.equal(fetched, 0);
});

test('a usage error is reported before anything is fetched', async () => {
  const { dir, env } = remoteWorkspace();
  const { code, err } = await cli(dir, ['--nope'], env);
  assert.equal(code, 1);
  assert.match(err, /unknown option --nope/);
  assert.equal(hits.size, 0);
});

function ageCache(env, days) {
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  for (const name of readdirSync(env.YAMLCTL_CACHE_DIR)) utimesSync(join(env.YAMLCTL_CACHE_DIR, name), past, past);
}
