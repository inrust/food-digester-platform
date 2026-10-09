import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function literalSourcePaths(file, name) {
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf(`const ${name} = [`);
  assert.notEqual(start, -1, `source manifest missing: ${file}`);
  const body = text.slice(start + `const ${name} = [`.length, text.indexOf(']', start));
  const paths = [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(body.replace(/'[^']+'/g, '').replace(/[\s,]/g, ''), '', 'literal manifest required');
  assert.equal(new Set(paths).size, paths.length, 'duplicate source path');
  return paths;
}

test('parent snapshot covers every executed child source before any cloud fixture starts', () => {
  const parent = literalSourcePaths('scripts/run-qa09-nonactive-target.mjs', 'sourcePaths');
  const child = literalSourcePaths('scripts/qa09-business-target.mjs', 'EXECUTED_BUSINESS_SOURCES');
  const missing = child.filter((path) => !parent.includes(path));
  assert.deepEqual(missing, [], 'a new child executor must be included in the original parent source snapshot');
  for (const path of parent) assert.ok(readFileSync(path).length > 0, `source file absent: ${path}`);
});
