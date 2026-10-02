import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCaRepairPermissions } from './qa09-ca-root-permissions.mjs';
const load = (n) => JSON.parse(readFileSync(`docs/audit/evidence/qa-09-ca-root-${n}-2026-10-02.json`));
const baseline = load('boundary-baseline').PolicyVersion.Document;
const boundary = load('boundary-proposed'),
  policy = load('worker-policy-proposed');
test('approved exact Worker, Secret, KMS and original expiry scope is accepted', () => {
  assert.doesNotThrow(() => assertCaRepairPermissions(baseline, boundary, policy));
});
test('removing role condition, wildcard Secret or extended expiry is rejected', () => {
  for (const mutate of [
    (b) => delete b.Statement.at(-1).Condition.ArnEquals,
    (b) => (b.Statement.at(-1).Resource = '*'),
    (b) => (b.Statement.at(-1).Condition.DateLessThan['aws:CurrentTime'] = '2026-10-04T00:00:00Z'),
    (b) => b.Statement[0].Action.push('secretsmanager:*'),
  ]) {
    const b = structuredClone(boundary);
    mutate(b);
    assert.throws(() => assertCaRepairPermissions(baseline, b, policy), /SCOPE_MISMATCH/);
  }
});
test('unrestricted KMS, different context or extra secret permissions are rejected', () => {
  for (const mutate of [
    (p) => p.Statement[1].Action.push('kms:*'),
    (p) => delete p.Statement[1].Condition.StringEquals,
    (p) => p.Statement[0].Action.push('secretsmanager:DeleteSecret'),
  ]) {
    const p = structuredClone(policy);
    mutate(p);
    assert.throws(() => assertCaRepairPermissions(baseline, boundary, p), /SCOPE_MISMATCH/);
  }
});

test('repair gate requires retained versions, exact output binding and all cleanup', async () => {
  const { validateCaRootRepair } = await import('./check-qa09-ca-root-repair.mjs');
  const { createHash } = await import('node:crypto');
  const baselineVersion = 'c10bbb97-033c-4758-9bcb-e75bb6bd5fa9',
    candidate = 'c1234567-1234-1234-1234-123456789abc';
  const r = {
    scope: 'AWS_ONLY_CA_ROOT_REPAIR_AND_TEN_DEVICE',
    account: '065986019555',
    region: 'ap-southeast-1',
    finishedAt: '2026-10-02T15:00:00Z',
    secretValuesExported: false,
    privateKeysExported: false,
    fullQa09Accepted: false,
    requestNonce: 'a'.repeat(32),
    candidateToken: candidate,
    repair: {
      schema: 'fdp-qa09-ca-root-repair/v1',
      completed: true,
      promoted: true,
      rolledBack: false,
      originalVersionRetained: true,
      otherFieldsUnchanged: true,
      secretValuesExported: false,
      baselineVersion,
      candidateVersion: candidate,
      requestNonce: 'a'.repeat(32),
    },
    afterVersionStages: { [baselineVersion]: ['AWSPREVIOUS'], [candidate]: ['AWSCURRENT'] },
    workerRefreshed: { bindingUnchanged: true },
    invocation: { ExecutedVersion: '1' },
    cleanup: [
      'worker-description-restored',
      'temporary-function-deleted',
      'temporary-worker-policy-revoked',
      'boundary-restored-v3-temporary-version-deleted',
      'original-worker-policy-and-boundary-preserved',
    ].map((type) => ({ type, result: 'PASS' })),
    sources: [
      'scripts/qa09-ca-root-repair-handler.mjs',
      'scripts/qa09-ca-root-repair.mjs',
      'scripts/qa09-ca-chain-diagnostic.mjs',
    ].map((path) => ({
      path,
      sourceBase64: Buffer.from('synthetic').toString('base64'),
      sha256: createHash('sha256').update('synthetic').digest('hex'),
    })),
  };
  assert.equal(validateCaRootRepair(r).gate, 'PASS');
  assert.equal(validateCaRootRepair(r).fullQa09Accepted, false);
  for (const mutate of [
    (r) => (r.repair.otherFieldsUnchanged = 'true'),
    (r) => (r.repair.originalVersionRetained = false),
    (r) => r.cleanup.pop(),
    (r) => (r.sources[0].sha256 = 'bad'),
    (r) => (r.repair.requestNonce = 'bad'),
    (r) => (r.afterVersionStages[baselineVersion] = []),
  ]) {
    const bad = structuredClone(r);
    mutate(bad);
    assert.throws(() => validateCaRootRepair(bad));
  }
});
