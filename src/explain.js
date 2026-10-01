// `yamlctl <resource> explain [field]`, the schema read back as text, the way `kubectl explain` reads an API.
// It is what someone writing a pipeline needs before the first `create`: which fields exist, what each holds, and which values it takes.
import { EXTENSION, escapeKey, types } from './schema.js';

export function explain(schema, map, segments) {
  const base = schema.entryPointer(map);
  const here = segments.length ? schema.field(base, segments, { throughLists: true }) : schema.unwrap(base);
  if (!here) throw new Error(`${map} has no field ${segments.join('.')}`);
  const { schema: node, pointer } = here;
  const lines = [];

  lines.push(`${segments.length ? `FIELD:  ${segments.join('.')}` : `RESOURCE:  ${map}`} <${describeType(schema, pointer, node)}>`);
  if (node.description) lines.push('', 'DESCRIPTION:', ...node.description.split('\n').map((line) => `  ${line}`));
  const values = node.enum ?? node.items?.enum;
  if (values) lines.push('', 'VALUES:', `  ${values.filter((v) => v !== null).map((v) => JSON.stringify(v)).join(', ')}`);
  if (node.default !== undefined) lines.push('', `DEFAULT:  ${JSON.stringify(node.default)}`);
  const rules = node[EXTENSION];
  if (rules && typeof rules === 'object') lines.push('', 'RULES:', ...Object.entries(rules).map(([name, value]) => `  ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`));

  const fields = fieldsOf(schema, pointer, node);
  if (fields.length) {
    const required = new Set(fieldsParent(schema, pointer, node).required ?? []);
    const rows = fields.map(([name, childPointer]) => {
      const { schema: child, pointer: resolved } = schema.unwrap(childPointer);
      return [name, `<${describeType(schema, resolved, child)}>${required.has(name) ? ' required' : ''}`, (child.description ?? '').split('\n')[0]];
    });
    const nameWidth = Math.max(...rows.map(([name]) => name.length));
    const typeWidth = Math.max(...rows.map(([, type]) => type.length));
    lines.push('', 'FIELDS:');
    for (const [name, type, summary] of rows) lines.push(`  ${name.padEnd(nameWidth)}  ${summary ? `${type.padEnd(typeWidth)}  ${summary}` : type}`);
  }
  return `${lines.join('\n')}\n`;
}

// The object whose properties are listed: the node itself, or the items of a list of objects.
function fieldsParent(schema, pointer, node) {
  if (node.properties) return node;
  if (node.items) return schema.unwrap(`${pointer}/items`).schema;
  return node;
}

function fieldsOf(schema, pointer, node) {
  if (node.properties) return Object.keys(node.properties).map((name) => [name, `${pointer}/properties/${escapeKey(name)}`]);
  if (node.items) {
    const items = schema.unwrap(`${pointer}/items`);
    if (items.schema.properties) return Object.keys(items.schema.properties).map((name) => [name, `${items.pointer}/properties/${escapeKey(name)}`]);
  }
  return [];
}

function describeType(schema, pointer, node) {
  const kinds = types(node).filter((type) => type !== 'null');
  if (kinds.includes('array') && node.items) {
    const items = schema.unwrap(`${pointer}/items`).schema;
    if (items.properties) return '[]object';
    if (items.enum) return '[]enum';
    return `[]${types(items).filter((type) => type !== 'null')[0] ?? 'any'}`;
  }
  if (node.enum) return 'enum';
  return kinds.join('|') || 'any';
}
