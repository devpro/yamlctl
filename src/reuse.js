// The results of a validator's functions, kept for the length of one check.
//
// ajv calls one function per `$ref` and remembers nothing, so alternatives leading back to the same schema are explored once per combination of branches, which is exponential in how deeply a value nests.
// Its errors repeat just as much, millions of them for a few distinct ones, so each function's are reduced as they leave it rather than once at the end.

// The start of the function ajv generates for a schema, everything before it being constants.
const GENERATED = /return function (validate\d+)(\([\s\S]*)$/;

// For ajv's `code.process` option, the one place where every generated function passes, calls to itself included.
// Code of another shape is left alone, which is slower and not wrong.
export const reuseResults = (code) => code.replace(GENERATED, 'const $1 = self.reuse(function $2); return $1');

// An evaluated set of properties is written into by whoever merges it with its own, so what is kept is never what is handed out.
const copied = (props) => (props && typeof props === 'object' ? { ...props } : props);
const copiedEvaluated = (evaluated) => ({ props: copied(evaluated.props), items: evaluated.items });
const isDynamic = (evaluated) => Boolean(evaluated?.dynamicProps || evaluated?.dynamicItems);

function at(map, key) {
  if (!map.has(key)) map.set(key, new Map());
  return map.get(key);
}

// `distinct` takes a function's errors and leaves out those that say nothing more.
export function reuser(distinct) {
  let depth = 0;
  // Dropped when the outermost function returns, since a value can be changed in place before it is checked again.
  let results = null;

  const recall = (validate, known) => {
    // The caller appends to these errors and truncates them.
    validate.errors = known.errors && [...known.errors];
    if (known.evaluated) Object.assign(validate.evaluated, copiedEvaluated(known.evaluated));
    return known.valid;
  };

  return (run) => {
    const validate = (data, context = {}) => {
      // Anchors are only ever added during a check, so their number stands for which ones are set.
      const anchors = () => Object.keys(context.dynamicAnchors ?? {}).length;
      const before = anchors();
      if (!depth) results = new Map();
      // The value is part of the key as well as its path, since a property name is checked at the path of the object holding it.
      const known = at(at(at(results, validate), before), context.instancePath ?? '');
      if (known.has(data)) return recall(validate, known.get(data));
      depth++;
      try {
        const valid = run(data, context);
        if (!valid) validate.errors = distinct(validate.errors);
        // A function that set an anchor has to run again wherever the anchor is not set yet.
        if (anchors() === before) {
          known.set(data, { valid, errors: validate.errors && [...validate.errors], evaluated: isDynamic(validate.evaluated) ? copiedEvaluated(validate.evaluated) : null });
        }
        return valid;
      } finally {
        depth--;
        if (!depth) results = null;
      }
    };
    return validate;
  };
}
