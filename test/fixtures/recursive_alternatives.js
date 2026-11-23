// Run in a child process by test/reuse.test.js, which kills it if it hangs.
// Counts the validations asked for and the values read, since a duration depends on the machine.
import { Schema } from '../../src/schema.js';

const branch = (i) => ({ type: 'object', required: [`k${i}`], properties: { c: { $ref: '#/definitions/n' } } });
const schema = new Schema({ definitions: { n: { anyOf: [0, 1, 2].map(branch) } }, $ref: '#/definitions/n' });

let reads = 0;
let value = {};
for (let i = 0; i < 8; i++) {
  const inner = value;
  value = {
    get c() {
      reads++;
      return inner;
    },
  };
}

let validations = 0;
const compiled = schema.compiled;
schema.compiled = function (...args) {
  validations++;
  return compiled.apply(this, args);
};

const messages = schema.validate('#', value, 'f');
process.stdout.write(JSON.stringify({ validations, reads, messages }));
