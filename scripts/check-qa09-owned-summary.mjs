import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateImplementationMatrix } from './check-qa09-observer-implementation.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const demand = (v, code) => {
  if (!v) throw Error(code);
};
export function validateOwnedRuntimeMatrix(matrix, load) {
  const result = validateImplementationMatrix(matrix, load);
  demand(matrix.observationDesignDecision === 'SELF_OWNED_BOUNDARIES_SCHEMA2_DEFAULT_OFF', 'OWNED_MATRIX_DESIGN');
  for (const item of matrix.rows) {
    const receipt = JSON.parse(load(item.receipt));
    for (const sample of receipt.samples)
      for (const row of sample.observations.filter((r) => r.event === 'data-path.contract-load.observer-cost'))
        demand(
          row.schemaVersion === 2 &&
            row.ownedBoundaries?.seam === 'SELF_OWNED_CALL_SITES' &&
            row.ownedBoundaries.includesObservationOverhead === true,
          'OWNED_MATRIX_SCHEMA',
        );
  }
  return {
    ...result,
    gate: 'LOCAL_OWNED_SUMMARY_PASS',
    targetGate: 'NOT_RUN',
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
export function inventory(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(root, resolve(e.parentPath, e.name)))
    .filter((p) => p !== 'manifest.json')
    .sort();
}
export function checkOwnedSummary(root) {
  const manifest = JSON.parse(readFileSync(root + '/manifest.json'));
  demand(
    JSON.stringify(inventory(root)) === JSON.stringify(Object.keys(manifest.files).sort()),
    'OWNED_SEAL_INVENTORY',
  );
  for (const [p, h] of Object.entries(manifest.files))
    demand(hash(readFileSync(resolve(root, p))) === h, 'OWNED_SEAL_BYTES:' + p);
  for (const [p, h] of Object.entries(manifest.bindings))
    demand(hash(readFileSync(p)) === h, 'OWNED_SOURCE_BYTES:' + p);
  const matrixRoot = root + '/sealed-runtime-matrix';
  const matrix = JSON.parse(readFileSync(matrixRoot + '/matrix.json'));
  for (const input of matrix.inputs)
    demand(hash(readFileSync(input.path)) === input.sha256, 'OWNED_RUNTIME_INPUT:' + input.path);
  const result = validateOwnedRuntimeMatrix(matrix, (name) => readFileSync(matrixRoot + '/' + name));
  const checks = JSON.parse(readFileSync(root + '/verify-results.json'));
  demand(
    checks.commands.length === 22 && checks.commands.every((c) => c.exitCode === 0) && checks.noCloudActions === true,
    'OWNED_VERIFY_REQUIRED',
  );
  const original = JSON.parse(readFileSync('package.json')).scripts.verify.split(' && ');
  demand(
    checks.commands.every((r, i) => r.original === original[i]),
    'OWNED_VERIFY_COMMANDS',
  );
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2];
  if (!root || process.argv.length !== 3) throw Error('OWNED_EVIDENCE_DIRECTORY_REQUIRED');
  demand(existsSync(root + '/manifest.json'), 'OWNED_SEAL_REQUIRED');
  const result = checkOwnedSummary(root);
  console.log(JSON.stringify(result));
}
