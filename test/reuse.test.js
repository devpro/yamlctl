import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { reuseResults, reuser } from '../src/reuse.js';
import { Schema } from '../src/schema.js';

const d2019 = 'https://json-schema.org/draft/2019-09/schema';

test('a value nested under recursive alternatives is checked without exploring every combination of branches', () => {
  const child = fileURLToPath(new URL('./fixtures/recursive_alternatives.js', import.meta.url));
  const { validations, reads, messages } = JSON.parse(execFileSync(process.execPath, [child], { encoding: 'utf8', timeout: 60000 }));
  // Once for the value itself, then once per branch at each of the 8 levels explained.
  assert.equal(validations, 25);
  assert.ok(reads < 1000, `${reads} reads`);
  assert.equal(messages.length, 28);
  assert.equal(messages[0], 'f: missing required field k0');
  assert.equal(new Set(messages).size, messages.length);
});

test('two places whose paths read the same each report their own value', () => {
  const schema = new Schema({
    definitions: { n: { anyOf: [{ type: 'string', minLength: 5 }, { type: 'integer', minimum: 10 }] } },
    type: 'object',
    properties: { 'a.b': { $ref: '#/definitions/n' }, a: { type: 'object', properties: { b: { $ref: '#/definitions/n' } } } },
  });
  assert.deepEqual(schema.validate('#', { 'a.b': 'x', a: { b: 1 } }, 'f'), ['f.a.b: must NOT have fewer than 5 characters', 'f.a.b: must be >= 10']);
});

test('the same wrong value at two places is reported at both', () => {
  const schema = new Schema({
    definitions: { n: { anyOf: [{ type: 'string', minLength: 5 }, { type: 'integer' }] } },
    type: 'object',
    properties: { a: { $ref: '#/definitions/n' }, b: { $ref: '#/definitions/n' } },
  });
  assert.deepEqual(schema.validate('#', { a: 'x', b: 'x' }, 'f'), ['f.a: must NOT have fewer than 5 characters', 'f.b: must NOT have fewer than 5 characters']);
});

test('a property name is not taken for the object holding it', () => {
  const schema = new Schema({
    definitions: { s: { type: 'string', allOf: [{ $ref: '#/definitions/t' }] }, t: { maxLength: 2, allOf: [{ $ref: '#/definitions/u' }] }, u: { type: 'string' } },
    allOf: [{ propertyNames: { $ref: '#/definitions/s' } }],
    anyOf: [{ not: { $ref: '#/definitions/s' } }, { type: 'number' }],
  });
  assert.deepEqual(schema.validate('#', { a: 1 }, 'f'), []);
});

test('a value changed in place is checked again', () => {
  const schema = new Schema({ definitions: { n: { type: 'object', properties: { a: { type: 'string' }, c: { $ref: '#/definitions/n' } } } }, $ref: '#/definitions/n' });
  const value = { c: { a: 1 } };
  assert.deepEqual(schema.validate('#', value, 'f'), ['f.c.a: must be string']);
  value.c.a = 'x';
  assert.deepEqual(schema.validate('#', value, 'f'), []);
});

test('an alternative reached again beyond the depth explained is reported as it is there', () => {
  const chain = Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`a${i}`, { anyOf: [{ $ref: `#/definitions/${i === 6 ? 'n' : `a${i + 1}`}` }] }]));
  const schema = new Schema({
    definitions: { ...chain, n: { anyOf: [{ type: 'object', properties: { x: { anyOf: [{ type: 'string', minLength: 3 }, { type: 'integer' }] } } }] } },
    anyOf: [{ $ref: '#/definitions/a1' }, { $ref: '#/definitions/n' }],
  });
  assert.deepEqual(schema.validate('#', { x: 'a' }, 'f'), ['f.x: must NOT have fewer than 3 characters']);
});

test('an error of a branch that does not matter, since another matches, is not reported', () => {
  const n = { $ref: '#/definitions/n' };
  const failing = { allOf: [n, { required: ['q'] }] };
  const schema = new Schema({
    definitions: { n: { type: 'object', required: ['k'], properties: { c: n } } },
    allOf: [{ anyOf: [failing, { type: 'object' }] }, { anyOf: [failing, { type: 'object' }] }, n],
  });
  assert.deepEqual(schema.validate('#', {}, 'f'), ['f: missing required field k']);
});

const either = { anyOf: [{ properties: { a: { type: 'integer' } }, required: ['a'] }, { properties: { b: { type: 'integer' } }, required: ['b'] }], properties: { deep: { $ref: '#/$defs/n' } } };

test('the properties a reference evaluates are those of the value it was applied to', () => {
  const n = { $ref: '#/$defs/n' };
  const schema = new Schema({
    $schema: d2019,
    $defs: { n: either },
    allOf: [{ not: { allOf: [n, { required: ['absent'] }] } }, { properties: { c: n } }, n],
    unevaluatedProperties: false,
  });
  assert.deepEqual(schema.validate('#', { a: 1, c: { b: 1 } }, 'f'), []);
  assert.deepEqual(schema.validate('#', { a: 1, b: 'x', c: { b: 1 } }, 'f'), ['f: must NOT have unevaluated properties']);
});

test('the properties one branch evaluates are not counted for another', () => {
  const n = { $ref: '#/$defs/n' };
  const more = (required) => ({ allOf: [n, { properties: { z: true } }], required: [required] });
  const schema = new Schema({ $schema: d2019, $defs: { n: either }, allOf: [{ not: more('absent') }, { not: more('missing') }, { ...n, unevaluatedProperties: false }] });
  assert.deepEqual(schema.validate('#', { a: 1, z: 1 }, 'f'), ['f: must NOT have unevaluated properties']);
});

test('the items a reference evaluates are counted each time it is applied', () => {
  const n = { $ref: '#/$defs/n' };
  const schema = new Schema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: { n: { anyOf: [{ prefixItems: [{ type: 'integer' }] }, { type: 'object' }], properties: { deep: n } } },
    allOf: [{ not: { allOf: [n, { minItems: 9 }] } }, n],
    unevaluatedItems: false,
  });
  assert.deepEqual(schema.validate('#', [1], 'f'), []);
  assert.deepEqual(schema.validate('#', [1, 2], 'f'), ['f: must NOT have more than 1 items']);
});

test('an anyOf and a oneOf failing on the same value are both considered, though their messages are the same', () => {
  const schema = new Schema({ anyOf: [{ allOf: [{ type: 'null' }] }], oneOf: [{ type: 'string', minLength: 5 }, { type: 'integer' }] });
  assert.deepEqual(schema.validate('#', 'x', 'f'), ['f: must NOT have fewer than 5 characters']);
});

test('a value too deep for results to be reused is still checked', () => {
  const schema = new Schema({ definitions: { n: { type: 'object', properties: { x: { type: 'string' }, c: { $ref: '#/definitions/n' } } } }, $ref: '#/definitions/n' });
  const deep = (value) => Array.from({ length: 3500 }).reduce((inner) => ({ c: inner }), value);
  assert.deepEqual(schema.validate('#', deep({}), 'f'), []);
  assert.deepEqual(schema.validate('#', deep({ x: 1 }), 'f'), [`f${'.c'.repeat(3500)}.x: must be string`]);
});

test('a reference cycle making no progress is refused', () => {
  const schema = new Schema({ definitions: { a: { anyOf: [{ $ref: '#/definitions/a' }, { type: 'string' }] } }, $ref: '#/definitions/a' });
  assert.throws(() => schema.validate('#', 1, 'f'), RangeError);
});

// The functions ajv generates stand in below as plain ones, where a schema setting anchors in the order needed would be read less easily than the rule.
test('a result is reused for the same value, path and anchors, within one check only', () => {
  const reuse = reuser((errors) => errors);
  let runs = 0;
  const inner = reuse(() => {
    runs++;
    return true;
  });
  const anchored = (context) => {
    inner('x', context);
    inner('x', context);
    context.dynamicAnchors.a = inner;
    inner('x', context);
    inner('y', context);
    inner('y', { ...context, instancePath: '/p' });
    return true;
  };
  const outer = reuse((_, context) => anchored(context));
  outer(0, { instancePath: '', dynamicAnchors: {} });
  assert.equal(runs, 4);
  outer(0, { instancePath: '', dynamicAnchors: {} });
  assert.equal(runs, 8);
});

test('a function that sets an anchor runs again, since setting it is part of what it does', () => {
  const reuse = reuser((errors) => errors);
  let runs = 0;
  const setting = reuse((_, { dynamicAnchors }) => {
    runs++;
    dynamicAnchors.a = setting;
    return true;
  });
  const outer = reuse(() => setting('x', { dynamicAnchors: {} }) && setting('x', { dynamicAnchors: {} }));
  outer(0);
  assert.equal(runs, 2);
});

test('generated code of an unknown shape is left as it is', () => {
  assert.equal(reuseResults('return (data) => true'), 'return (data) => true');
});
