import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, logRows } from './qa09-minimum-a5-proof.mjs';
import { naturalSummaryBusinessAssociation } from './qa09-natural-summary-association.mjs';
export function collectNaturalSummary(parentPath, finalPath, upsertPath, completedPath, output) {
  if (existsSync(output)) throw Error('FRESH_NATURAL_ASSOCIATION_REQUIRED');
  const read = (p) => JSON.parse(readFileSync(p)),
    p = read(parentPath),
    final = read(finalPath),
    frozen = read(parentPath + '.sources.json');
  if (
    final.gate !== 'PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' ||
    final.parentSha256 !== sha256(readFileSync(parentPath)) ||
    final.archiveReader?.gate !== 'PASS_INDEPENDENTLY_ABSENT_AND_EXISTING_POLICY_UNCHANGED'
  )
    throw Error('INDEPENDENT_CLEANUP_REQUIRED');
  const beforePath = p.databaseBuilds.find((b) => b.action === 'consistency-observe' && b.gate === 'PASS').receipt,
    cleanupPath = p.databaseBuilds.find((b) => b.action === 'cleanup' && b.gate === 'PASS').receipt,
    before = read(beforePath),
    cleanup = read(cleanupPath),
    expectedSource = frozen.sources.find((s) => s.path === 'scripts/qa09-ten-device-db.mjs').sha256;
  if ([before, cleanup].some((r) => r.sourceHash !== expectedSource || r.gate !== 'PASS'))
    throw Error('FROZEN_DATABASE_SOURCE_REQUIRED');
  const rows = [...logRows(read(upsertPath).events), ...logRows(read(completedPath).events)],
    proof = naturalSummaryBusinessAssociation(p, before.result, cleanup.result, rows);
  const files = [
    parentPath,
    parentPath + '.sources.json',
    finalPath,
    beforePath,
    cleanupPath,
    upsertPath,
    completedPath,
  ];
  const r = {
    scope: 'NATURAL_SUMMARY_EXECUTION_ASSOCIATION_NOT_NEW_DATA_VALUE_ACCEPTANCE',
    applicationCommit: p.sourceCommit,
    parentPath,
    finalPath,
    beforePath,
    cleanupPath,
    rows,
    proof,
    checkedAt: new Date().toISOString(),
    bindings: files.map((path) => ({ path, sha256: sha256(readFileSync(path)) })),
  };
  writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
  return r;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(collectNaturalSummary(...process.argv.slice(2)).proof.result);
