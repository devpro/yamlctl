import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Schema, findSchema, loadSchema, typedValue } from '../src/schema.js';
import { emptyDir, workspace, write } from './helpers.js';

const projectSchema = (dir) => loadSchema(join(dir, 'schemas', 'project.schema.json'));

test('the schema a file names on its first line is the one used, relative to the file', () => {
  const found = findSchema('/data/project.yaml', '# yaml-language-server: $schema=schemas/p.json\nprojects: {}\n');
  assert.deepEqual(found, { uri: 'file:///data/schemas/p.json', named: true });
});

test('an absolute schema path is taken as it is', () => {
  assert.equal(findSchema('/data/project.yaml', '# yaml-language-server: $schema=/etc/p.json\n').uri, 'file:///etc/p.json');
});

test('the schema line is found with the spacing an editor tolerates', () => {
  assert.equal(findSchema('/d/p.yaml', '#yaml-language-server:  $schema=x.json\n').uri, 'file:///d/x.json');
});

test('a remote schema is named by its address, and a scheme other than file or http(s) is flagged', () => {
  assert.deepEqual(findSchema('/d/p.yaml', '# yaml-language-server: $schema=https://example.com/p.json\n'), { uri: 'https://example.com/p.json', named: true });
  assert.deepEqual(findSchema('/d/p.yaml', '# yaml-language-server: $schema=ftp://example.com/p.json\n'), { uri: 'ftp://example.com/p.json', named: true, unsupported: true });
  assert.deepEqual(findSchema('/d/p.yaml', '# yaml-language-server: $schema=file:///s/p.json\n'), { uri: 'file:///s/p.json', named: true });
});

test('without the line, schemas/<name>.schema.json is found beside the file', () => {
  const dir = workspace();
  assert.deepEqual(findSchema(join(dir, 'project.yaml'), 'projects: {}\n'), { uri: pathToFileURL(join(dir, 'schemas', 'project.schema.json')).href, named: false });
});

test('without the line or a schemas folder, <name>.schema.json beside the file is found', () => {
  const dir = emptyDir();
  write(dir, 'servers.schema.json', '{}');
  assert.equal(findSchema(join(dir, 'servers.yaml'), '').uri, pathToFileURL(join(dir, 'servers.schema.json')).href);
});

test('a .yml file finds its schema by the same name', () => {
  const dir = emptyDir();
  mkdirSync(join(dir, 'schemas'));
  write(dir, 'schemas/servers.schema.json', '{}');
  assert.equal(findSchema(join(dir, 'servers.yml'), '').uri, pathToFileURL(join(dir, 'schemas', 'servers.schema.json')).href);
});

test('no schema anywhere is null, not an error', () => {
  assert.deepEqual(findSchema(join(emptyDir(), 'a.yaml'), ''), { uri: null, named: false });
});

test('a schema that is not JSON is refused with its path', () => {
  const dir = emptyDir();
  write(dir, 'bad.json', '{ nope');
  assert.throws(() => loadSchema(join(dir, 'bad.json')), /bad\.json is not a readable JSON Schema/);
});

test('a schema that is JSON but not an object is refused', () => {
  const dir = emptyDir();
  write(dir, 'list.json', '[]');
  assert.throws(() => loadSchema(join(dir, 'list.json')), /does not hold a JSON Schema object/);
});

test('a reference is followed and a nullable wrapper taken off', () => {
  const schema = projectSchema(workspace());
  assert.equal(schema.unwrap('#/properties/projects_defaults').pointer, `${schema.uri}#/definitions/project`);
  assert.equal(schema.unwrap('#/properties/projects/additionalProperties').pointer, `${schema.uri}#/definitions/project`);
  assert.match(schema.uri, /^file:\/\/.*\/schemas\/project\.schema\.json$/);
});

test('oneOf with a null branch unwraps like anyOf', () => {
  const schema = new Schema({ properties: { a: { oneOf: [{ type: 'null' }, { type: 'string' }] } } });
  assert.deepEqual(schema.unwrap('#/properties/a').schema, { type: 'string' });
});

test('an anyOf with two real branches is left as it is', () => {
  const schema = new Schema({ properties: { a: { anyOf: [{ type: 'string' }, { type: 'number' }] } } });
  assert.equal(schema.unwrap('#/properties/a').pointer, 'urn:yamlctl:inline#/properties/a');
});

test('a chain of references is followed to its end', () => {
  const schema = new Schema({ definitions: { a: { $ref: '#/definitions/b' }, b: { $ref: '#/definitions/c' }, c: { type: 'string' } }, properties: { x: { $ref: '#/definitions/a' } } });
  assert.equal(schema.unwrap('#/properties/x').pointer, 'urn:yamlctl:inline#/definitions/c');
});

test('a reference to itself stops instead of looping', () => {
  const schema = new Schema({ definitions: { a: { $ref: '#/definitions/a' } } });
  assert.throws(() => schema.unwrap('#/definitions/a'), /references itself too deeply/);
});

test('a reference to a file that does not exist names it', () => {
  const dir = emptyDir();
  write(dir, 'root.json', JSON.stringify({ properties: { a: { $ref: 'missing.json#/x' } } }));
  const schema = loadSchema(join(dir, 'root.json'));
  assert.deepEqual(schema.missing, [pathToFileURL(join(dir, 'missing.json')).href]);
  assert.throws(() => schema.unwrap('#/properties/a'), /missing\.json is referenced by the schema and could not be loaded/);
  assert.throws(() => schema.validate('#', {}, 'f'), /the schema cannot be applied, .*missing\.json could not be loaded/);
});

test('a relative reference in a schema built in memory names what it could not load', () => {
  const schema = new Schema({ properties: { a: { $ref: 'other.json#/x' } } });
  assert.throws(() => schema.unwrap('#/properties/a'), /other\.json is referenced by the schema and could not be loaded/);
});

test('an anchor is not followed, and says so', () => {
  const schema = new Schema({ properties: { a: { $ref: '#thing' } } });
  assert.throws(() => schema.unwrap('#/properties/a'), /names an anchor, which is not followed/);
});

test('a pointer to nothing names what is missing', () => {
  assert.throws(() => new Schema({}).at('#/definitions/none'), /urn:yamlctl:inline has nothing at #\/definitions\/none/);
});

test('an entry map is found from its shape, and the defaults beside it are not one', () => {
  assert.deepEqual(projectSchema(workspace()).entryMaps(), ['projects']);
});

test('a map can opt out of being treated as entries', () => {
  const schema = new Schema({ properties: { settings: { type: 'object', additionalProperties: { type: 'object' }, 'x-yamlctl': { entries: false } } } });
  assert.deepEqual(schema.entryMaps(), []);
});

test('a map of scalars is not a map of entries it could not hold', () => {
  const schema = new Schema({ properties: { labels: { type: 'object', additionalProperties: { type: 'string' } }, items: { type: 'object', additionalProperties: { type: 'object' } } } });
  assert.deepEqual(schema.entryMaps(), ['items']);
});

test('draft 2020-12 with $defs is read the same way', () => {
  const dir = workspace();
  const schema = loadSchema(join(dir, 'schemas', 'policy.schema.json'));
  assert.deepEqual(schema.entryMaps(), ['ignore_rules', 'scan_policies']);
  assert.equal(schema.entryPointer('ignore_rules'), `${schema.uri}#/$defs/rule`);
});

test('a field path walks nested objects, and a missing field is null', () => {
  const schema = projectSchema(workspace());
  const entry = schema.entryPointer('projects');
  assert.deepEqual(schema.field(entry, ['risk_profile', 'business_impact']).schema.enum, ['LBI', 'MBI', 'HBI', null]);
  assert.equal(schema.field(entry, ['risk_profle']), null);
  assert.equal(schema.field(entry, ['name', 'deeper']), null);
});

test('a field of a map of values and a field matching a pattern are both found', () => {
  const schema = projectSchema(workspace());
  const entry = schema.entryPointer('projects');
  assert.deepEqual(schema.field(entry, ['tags', 'team']).schema, { type: 'string' });
  assert.deepEqual(schema.field(entry, ['labels', 'x-owner']).schema, { type: 'string' });
  assert.equal(schema.field(entry, ['labels', 'owner']), null);
});

test('a string field keeps the text exactly, leading zero, yes and no included', () => {
  assert.equal(typedValue({ type: 'string' }, '005217217997'), '005217217997');
  assert.equal(typedValue({ type: ['string', 'null'] }, 'no'), 'no');
  assert.equal(typedValue({ type: 'string' }, 'true'), 'true');
});

test('a boolean, an integer and a number are typed', () => {
  assert.equal(typedValue({ type: ['boolean', 'null'] }, 'true'), true);
  assert.equal(typedValue({ type: 'boolean' }, 'false'), false);
  assert.equal(typedValue({ type: 'integer' }, '42'), 42);
  assert.equal(typedValue({ type: 'number' }, '1.5'), 1.5);
});

test('a value the type cannot hold is refused', () => {
  assert.throws(() => typedValue({ type: 'boolean' }, 'yes'), /expected boolean, got yes/);
  assert.throws(() => typedValue({ type: 'integer' }, '1.5'), /expected integer, got 1\.5/);
  assert.throws(() => typedValue({ type: 'number' }, 'many'), /expected number/);
});

test('null is accepted where the type allows it', () => {
  assert.equal(typedValue({ type: ['integer', 'null'] }, 'null'), null);
});

test('a list and an object are read as JSON', () => {
  assert.deepEqual(typedValue({ type: ['array', 'null'] }, '["a", "b"]'), ['a', 'b']);
  assert.deepEqual(typedValue({ type: 'object' }, '{"a": 1}'), { a: 1 });
  assert.throws(() => typedValue({ type: 'array' }, '[a'), /expected array written as JSON/);
});

test('an enum matches the spelling of its own values, numbers included', () => {
  assert.equal(typedValue({ enum: [1, 2, 3] }, '3'), 3);
  assert.equal(typedValue({ enum: ['LBI', 'HBI'] }, 'HBI'), 'HBI');
  assert.equal(typedValue({ enum: [true, false] }, 'true'), true);
  assert.equal(typedValue({ enum: ['A', null] }, 'null'), null);
  assert.equal(typedValue({ const: 'fixed' }, 'fixed'), 'fixed');
});

test('an untyped field takes the text as it is', () => {
  assert.equal(typedValue({}, '12'), '12');
});

test('a value outside an enum is reported with the allowed values', () => {
  const schema = projectSchema(workspace());
  const problems = schema.validate(schema.entryPointer('projects'), { name: 'X', risk_profile: { business_impact: 'HIGH' } }, 'projects/x');
  assert.deepEqual(problems, ['projects/x.risk_profile.business_impact: must be one of "LBI", "MBI", "HBI"']);
});

test('an unknown field is named, which a type conversion would drop without a word', () => {
  const schema = projectSchema(workspace());
  assert.deepEqual(schema.validate(schema.entryPointer('projects'), { nme: 'X' }, 'projects/x'), ['projects/x: no such field nme']);
});

test('a wrong type, a missing required field and a nested list item are all reported', () => {
  const schema = projectSchema(workspace());
  const problems = schema.validate(schema.entryPointer('projects'), { name: 3, account_links: [{ environment: 'DEV' }] }, 'p');
  assert.ok(problems.includes('p.name: must be string or null'), problems.join('\n'));
  assert.ok(problems.includes('p.account_links.0: missing required field account'), problems.join('\n'));
  assert.ok(problems.includes('p.account_links.0.environment: must be one of "PRODUCTION", "STAGING"'), problems.join('\n'));
});

test('a nullable value reports its real problem once, not once per branch', () => {
  const schema = projectSchema(workspace());
  const problems = schema.validate('#', { projects: {}, projects_defaults: { nme: 1 } }, 'file');
  assert.deepEqual(problems, ['file.projects_defaults: no such field nme']);
});

test('a valid value reports nothing', () => {
  const schema = projectSchema(workspace());
  assert.deepEqual(schema.validate(schema.entryPointer('projects'), { name: 'X', tags: { team: 'a' } }, 'p'), []);
});

test('a keyword the validator does not know is tolerated, since an editor schema carries some', () => {
  const schema = new Schema({ type: 'object', properties: { a: { type: 'string', markdownDescription: 'x', 'x-custom': 1 } } });
  assert.deepEqual(schema.validate('#', { a: 'ok' }, 'f'), []);
});

test('draft 2019-09 is validated with its own dialect', () => {
  const schema = new Schema({ $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false });
  assert.deepEqual(schema.validate('#', { a: 'x', b: 1 }, 'f'), ['f: no such field b']);
});

// --- alternatives

const shapes = new Schema({
  definitions: {
    job: { type: 'object', additionalProperties: false, required: ['runs'], properties: { runs: { type: 'string' }, steps: { type: 'array' }, timeout: { oneOf: [{ type: 'number' }, { type: 'string', pattern: '^\\$\\{\\{.*\\}\\}$' }] } } },
    call: { type: 'object', additionalProperties: false, required: ['uses'], properties: { uses: { type: 'string' }, with: { type: 'object' } } },
  },
  type: 'object',
  properties: { jobs: { type: 'object', additionalProperties: { oneOf: [{ $ref: '#/definitions/job' }, { $ref: '#/definitions/call' }] } } },
});

test('a failing alternative is reported through the branch the value is closest to, not every branch', () => {
  const problems = shapes.validate('#', { jobs: { build: { runz: 'x', steps: [] } } }, 'f');
  assert.deepEqual(problems, ['f.jobs.build: missing required field runs', 'f.jobs.build: no such field runz']);
});

test('the other branch is chosen when the value is shaped like it', () => {
  assert.deepEqual(shapes.validate('#', { jobs: { reuse: { use: 'x', with: {} } } }, 'f'), ['f.jobs.reuse: missing required field uses', 'f.jobs.reuse: no such field use']);
});

test('a branch whose problems are deeper wins a tie in the count, since its shape matched', () => {
  const problems = shapes.validate('#', { jobs: { build: { runz: 'x', steps: [], timeout: 'ten' } } }, 'f');
  assert.ok(!problems.some((problem) => problem.includes('uses')), problems.join('\n'));
  assert.ok(problems.includes('f.jobs.build: missing required field runs'), problems.join('\n'));
});

test('between a number and a text form, a text value is reported against the text form', () => {
  assert.deepEqual(shapes.validate('#', { jobs: { build: { runs: 'x', timeout: 'ten' } } }, 'f'), ['f.jobs.build.timeout: must match the pattern "^\\\\$\\\\{\\\\{.*\\\\}\\\\}$"']);
});

test('two branches of the same type that fail the same way are both reported, since each says something true', () => {
  const schema = new Schema({ type: 'object', properties: { a: { anyOf: [{ type: 'string', minLength: 5 }, { type: 'string', pattern: '^x' }] } } });
  assert.deepEqual(schema.validate('#', { a: 'ab' }, 'f'), ['f.a: must NOT have fewer than 5 characters', 'f.a: must match the pattern "^x"']);
});

test('a pattern with a line break in it is printed on one line', () => {
  const schema = new Schema({ type: 'object', properties: { a: { type: 'string', pattern: 'x[\r\n]y' } } });
  const [problem] = schema.validate('#', { a: 'z' }, 'f');
  assert.equal(problem.includes('\n'), false);
  assert.match(problem, /must match the pattern "x\[\\r\\n\]y"/);
});

test('a oneOf matched by two branches says so', () => {
  const schema = new Schema({ type: 'object', properties: { a: { oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }] } } });
  assert.deepEqual(schema.validate('#', { a: 'x' }, 'f'), ['f.a: matches more than one of the alternatives, where exactly one is expected']);
});

test('an anyOf nothing matches, with branches that cannot be located, still reports its problems', () => {
  const schema = new Schema({ anyOf: [{ type: 'object', required: ['a'] }, { type: 'object', required: ['b'] }] });
  const problems = schema.validate('#', {}, 'f');
  assert.ok(problems.includes('f: missing required field a') || problems.includes('f: missing required field b'), problems.join('\n'));
});

test('alternatives inside a list item are located through the item schema', () => {
  const schema = new Schema({ type: 'object', properties: { items: { type: 'array', items: { oneOf: [{ type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } }, { type: 'string' }] } } } });
  assert.deepEqual(schema.validate('#', { items: [{ b: 1 }] }, 'f'), ['f.items.0: no such field b']);
});

test('a field path goes into list items only when asked, and says it did', () => {
  const schema = projectSchema(workspace());
  const entry = schema.entryPointer('projects');
  assert.equal(schema.field(entry, ['account_links', 'account']), null);
  const through = schema.field(entry, ['account_links', 'account'], { throughLists: true });
  assert.deepEqual(through.schema, { type: 'string' });
  assert.equal(through.crossed, true);
  assert.equal(schema.field(entry, ['name']).crossed, false);
});
