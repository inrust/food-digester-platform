import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { assertConsistency } from '../../../../scripts/qa09-esg-closeout.mjs';
import { sha256 } from '../../../../scripts/qa09-reliability-closeout.mjs';
const root = 'docs/audit/evidence/qa-09-close-07-esg-2026-10-13/';
const bytes = readFileSync(root + 'target-v2.json.reliability.json');
const child = JSON.parse(bytes), parent = JSON.parse(readFileSync(root + 'target-v2.json'));
assert.equal(child.gate, 'FAIL');
assert.equal(child.failure.code, 'PUBLISHED_ARCHIVE_BINDING_REQUIRED');
const consistency = assertConsistency(child.consistencyFrame, child.telemetry, child.reports, parent.devices, parent.customers);
writeFileSync(root + 'v2-retained-frame-reassessment.json', JSON.stringify({
  gate: 'PASS_REASSESSMENT_ONLY_ORIGINAL_FAIL_RETAINED', sourceCommit: child.sourceCommit, prefix: child.prefix,
  originalGate: child.gate, originalGatePromoted: false, childSha256: sha256(bytes),
  assessorSha256: sha256(readFileSync(import.meta.filename)),
  correctedAssertionSha256: sha256(readFileSync('scripts/qa09-esg-closeout.mjs')),
  consistency, archiveProofNotRun: true, exportsNotRun: true, fullQa09Accepted: false,
}, null, 2) + '\n');
