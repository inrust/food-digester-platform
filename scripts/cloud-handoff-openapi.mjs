/** Resolve a frozen operation subset without external references or protocol changes. */
export function subsetOpenApi({ document, documents, paths, securitySchemes }) {
  const components = { schemas: {}, securitySchemes: {} },
    origins = new Map();
  function rewrite(value, context = document) {
    if (Array.isArray(value)) return value.map((entry) => rewrite(entry, context));
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) {
      const match = /^([^#]*)#\/components\/(schemas|securitySchemes|responses)\/([^/]+)$/.exec(value.$ref);
      if (!match) throw new Error(`UNSUPPORTED_HANDOFF_REF: ${value.$ref}`);
      const [, file, kind, name] = match;
      const source = file ? documents[file] : context;
      const original = source?.components[kind]?.[name];
      if (!original) throw new Error(`MISSING_HANDOFF_REF: ${value.$ref}`);
      const siblings = () =>
        Object.fromEntries(
          Object.entries(value)
            .filter(([key]) => key !== '$ref')
            .map(([key, item]) => [key, rewrite(item, context)]),
        );
      if (original.$ref) return { ...rewrite(original, source), ...siblings() };
      const key = `${kind}/${name}`;
      if (origins.has(key) && origins.get(key) !== source) throw new Error(`AMBIGUOUS_HANDOFF_REF: ${name}`);
      if (!origins.has(key)) {
        origins.set(key, source);
        components[kind] ??= {};
        components[kind][name] = {};
        components[kind][name] = rewrite(original, source);
      }
      return { ...siblings(), $ref: `#/components/${key}` };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item, context)]));
  }
  const operations = Object.fromEntries(
    paths.map((path) => {
      if (!document.paths[path]) throw new Error(`MISSING_HANDOFF_PATH: ${path}`);
      return [path, rewrite(document.paths[path])];
    }),
  );
  for (const scheme of securitySchemes) rewrite({ $ref: `#/components/securitySchemes/${scheme}` });
  return { paths: operations, components };
}
