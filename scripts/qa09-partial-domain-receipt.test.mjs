import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePartialDomainReceipt } from './qa09-partial-domain-receipt.mjs';
const expected = {
  validator: 'scripts/check-example-evidence.mjs',
  validatorSha256: 'a'.repeat(64),
  requiredSets: { REQUIRED_OPERATIONS: ['updateSite'] },
};
function receipt() {
  return {
    ...expected,
    kind: 'PARTIAL_DOMAIN_RECEIPT_ASSEMBLY_NOT_LEGACY_PASS_RECEIPT',
    status: 'PARTIAL_NOT_ACCEPTED',
    fullOriginalGatePassed: false,
    fullQa09Accepted: false,
    originalValidatorModified: false,
    operationCoverage: [
      {
        operationId: 'updateSite',
        roleRows: [
          {
            role: 'PlatformOperator',
            status: 'PASS_SCOPED_PERSISTENCE',
            proofs: [
              {
                operationId: 'updateSite',
                role: 'PlatformOperator',
                proofKind: 'ATOMIC_AUDIT_SNAPSHOT',
                receiptSha256: 'b'.repeat(64),
                specializedValidation: 'PASS',
                sourceCompatible: true,
                cleanupVerified: true,
              },
            ],
          },
        ],
      },
    ],
    evidence: { operationRoles: ['updateSite:PlatformOperator'] },
    workflowCoverage: [],
    probeCoverage: [],
  };
}
test('partial assembly validation cannot sign formal acceptance', () => {
  assert.equal(validatePartialDomainReceipt(receipt(), expected).formalAccepted, false);
  for (const delta of [
    { status: 'PASS' },
    { fullOriginalGatePassed: true },
    { fullQa09Accepted: true },
    { originalValidatorModified: true },
    { validatorSha256: 'c'.repeat(64) },
  ])
    assert.throws(() => validatePartialDomainReceipt({ ...receipt(), ...delta }, expected));
});
test('missing operations and arbitrary HTTP flags cannot satisfy a partial domain proof', () => {
  const r = receipt();
  r.operationCoverage = [];
  assert.throws(() => validatePartialDomainReceipt(r, expected));
  const x = receipt();
  x.operationCoverage[0].roleRows[0].proofs[0].proofKind = 'HTTP_ONLY';
  assert.throws(() => validatePartialDomainReceipt(x, expected));
  const y = receipt();
  y.operationCoverage[0].roleRows[0].proofs[0].role = 'CustomerAdmin';
  assert.throws(() => validatePartialDomainReceipt(y, expected));
});
test('ancillary requirements remain explicitly unaccepted', () => {
  const r = receipt();
  r.probeCoverage = [{ path: 'settingVersionRace', status: 'PASS' }];
  assert.throws(() => validatePartialDomainReceipt(r, expected));
  const x = receipt();
  x.evidence.operationRoles.push('deleteSite:PlatformOperator');
  assert.throws(() => validatePartialDomainReceipt(x, expected));
  const y = receipt();
  const required = {
    ...expected,
    requiredSets: { ...expected.requiredSets, REQUIRED_WORKFLOWS: ['owned-write-readback'] },
  };
  y.requiredSets = required.requiredSets;
  assert.throws(() => validatePartialDomainReceipt(y, required));
});
