// The checks JSON Schema cannot express because they look at more than one entry, each declared on a field with `x-yamlctl`:
//
//   key-of       the value names an entry of a map in the same file, "." for the map the field belongs to
//   target-must  the entry it names has these values, read with that map's defaults applied
//   immutable    changing the value on an existing entry needs --force, and the text says why
//
// A map declares `x-yamlctl.defaults`, the sibling property its entries inherit from, which is where a field left out of an entry is read from.
// docs/schema-extensions.md is the reference for all of them.
import { EXTENSION } from './schema.js';

// The fields of one entry that carry rules, top level only, since a reference between entries is a property of the entry rather than of something nested in it.
export function fieldRules(schema, map) {
  const { schema: entry } = schema.unwrap(schema.entryPointer(map));
  const rules = [];
  for (const [field, property] of Object.entries(entry?.properties ?? {})) {
    const declared = property?.[EXTENSION];
    if (declared && typeof declared === 'object') rules.push({ field, ...declared });
  }
  return rules;
}

export function defaultsOf(schema, data, map) {
  const sibling = schema?.mapOptions(map).defaults;
  const value = sibling ? data[sibling] : null;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

const effective = (entry, defaults, field) => (entry?.[field] !== undefined && entry?.[field] !== null ? entry[field] : (defaults[field] ?? null));

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// The reasons an entry about to be written breaks a rule, empty when it does not.
// `data` is the file as it will be once written, so an entry may name another written by the same command, and `previous` the file as it is, which an immutable field is compared with.
export function checkSet({ schema, data, previous = data, map, key, entry, force }) {
  if (!schema) return [];
  const problems = [];
  const defaults = defaultsOf(schema, data, map);
  for (const rule of fieldRules(schema, map)) {
    const value = effective(entry, defaults, rule.field);
    if (rule['key-of'] && value !== null) problems.push(...namedProblems(rule, value, { schema, data, map, key }));
    if (rule.immutable && Object.hasOwn(previous[map] ?? {}, key) && !force) {
      const before = effective(previous[map][key], defaultsOf(schema, previous, map), rule.field);
      problems.push(...immutableProblems(rule, before, value));
    }
  }
  return problems;
}

const mapNamedBy = (rule, map) => (rule['key-of'] === '.' ? map : rule['key-of']);

const listed = (value) => (Array.isArray(value) ? value : [value]);

function namedProblems(rule, value, { schema, data, map, key }) {
  const targetMap = mapNamedBy(rule, map);
  const targets = data[targetMap] ?? {};
  return listed(value).flatMap((name) => {
    if (targetMap === map && name === key) return [`${rule.field}: ${key} cannot name itself`];
    if (!Object.hasOwn(targets, name)) return [`${rule.field}: ${name} is not an entry of ${targetMap}, create it first`];
    return targetProblems(rule, name, targets[name], defaultsOf(schema, data, targetMap));
  });
}

function targetProblems(rule, name, target, defaults) {
  return Object.entries(rule['target-must'] ?? {}).flatMap(([field, expected]) => {
    const actual = effective(target, defaults, field);
    return same(actual, expected) ? [] : [`${rule.field}: ${name} must have ${field}: ${JSON.stringify(expected)}, it has ${JSON.stringify(actual)}`];
  });
}

function immutableProblems(rule, before, value) {
  if (same(before, value)) return [];
  const reason = typeof rule.immutable === 'string' ? `, ${rule.immutable}` : '';
  return [`${rule.field}: changing ${JSON.stringify(before)} to ${JSON.stringify(value)} needs --force${reason}`];
}

// The entries still naming one about to be deleted, since deleting it would leave each of them pointing at nothing.
export function referencesTo({ schema, data, map, key }) {
  if (!schema) return [];
  const found = [];
  for (const other of schema.entryMaps()) {
    const defaults = defaultsOf(schema, data, other);
    const rules = fieldRules(schema, other).filter((rule) => rule['key-of'] && mapNamedBy(rule, other) === map);
    for (const rule of rules) {
      const naming = Object.entries(data[other] ?? {}).filter(([name, entry]) => !(other === map && name === key) && listed(effective(entry, defaults, rule.field)).includes(key));
      found.push(...naming.map(([name]) => `${other}/${name}`));
    }
  }
  return found;
}

// Every entry of a file against the rules, for `check`, which reads a file someone may have edited by hand.
export function checkAll({ schema, data }) {
  if (!schema) return [];
  const problems = [];
  for (const map of schema.entryMaps()) {
    for (const [key, entry] of Object.entries(data[map] ?? {})) {
      for (const problem of checkSet({ schema, data, map, key, entry, force: true })) problems.push(`${map}/${key}: ${problem}`);
    }
  }
  return problems;
}
