import { test } from 'node:test';
import assert from 'node:assert/strict';
import forge from 'node-forge';
import { diagnoseCaChain } from './qa09-ca-chain-diagnostic.mjs';
function ca(name, parent) {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = parent ? '02' : '01';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2036-01-01T00:00:00Z');
  certificate.setSubject([{ name: 'commonName', value: name }]);
  certificate.setIssuer(parent?.certificate.subject.attributes ?? certificate.subject.attributes);
  certificate.setExtensions([{ name: 'basicConstraints', cA: true, critical: true }]);
  certificate.sign(parent?.keys.privateKey ?? keys.privateKey, forge.md.sha256.create());
  return {
    keys,
    certificate,
    pem: forge.pki.certificateToPem(certificate),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
const root = ca('Synthetic Root');
const intermediate = ca('Synthetic Intermediate', root);
const trust = intermediate.pem + root.pem;
const secret = {
  caCertificatePem: intermediate.pem,
  caPrivateKeyPem: intermediate.privateKey,
  caCertificateChainPem: root.pem,
};
const now = new Date('2026-10-02T00:00:00Z');
function run(value = secret, pem = trust, time = now) {
  return diagnoseCaChain(JSON.stringify(value), pem, time);
}
test('complete intermediate/root chain matches truststore and private key', () => {
  const r = run();
  assert.equal(r.workerChainValid, true);
  assert.equal(r.configuredChainEqualsTruststoreInOrder, true);
  assert.equal(r.privateKeyMatchesSigningCertificate, true);
  assert.equal(r.privateKeyMatchesTruststoreFirstCertificate, true);
  assert.deepEqual(r.findings, []);
});
test('missing root is distinguished from valid signing certificate and key', () => {
  const { caCertificateChainPem: omitted, ...value } = secret;
  assert.ok(omitted);
  const r = run(value);
  assert.equal(r.workerChainValid, false);
  assert.equal(r.fields.caCertificateChainPemPresent, false);
  assert.equal(r.privateKeyMatchesSigningCertificate, true);
  assert.equal(r.signingCertificateMatchesTruststoreFirst, true);
  assert.equal(r.missingTruststoreFingerprints.length, 1);
  assert.ok(r.findings.includes('TERMINAL_CERTIFICATE_NOT_SELF_SIGNED'));
});
test('wrong parent, expired chain and wrong private key fail independently', () => {
  const wrong = run({ ...secret, caCertificateChainPem: intermediate.pem });
  assert.equal(wrong.workerChainValid, false);
  assert.ok(wrong.findings.includes('CHAIN_PARENT_OR_SIGNATURE_INVALID'));
  const expired = run(secret, trust, new Date('2037-01-01T00:00:00Z'));
  assert.equal(expired.workerChainValid, false);
  assert.ok(expired.findings.includes('CERTIFICATE_OUTSIDE_VALIDITY'));
  assert.ok(run({ ...secret, caPrivateKeyPem: root.privateKey }).findings.includes('SIGNING_KEY_MISMATCH'));
});
test('oversized worker chain, malformed values and arbitrary canaries never leak', () => {
  assert.ok(run({ ...secret, caCertificateChainPem: root.pem.repeat(3) }).findings.includes('WORKER_CHAIN_TOO_LONG'));
  const canary = 'private-secret-canary-value';
  const r = run({ caCertificatePem: canary, caPrivateKeyPem: canary, arbitraryField: canary });
  assert.equal(r.workerChainValid, false);
  assert.ok(!JSON.stringify(r).includes(canary));
  assert.ok(!JSON.stringify(run()).includes('BEGIN CERTIFICATE'));
  assert.ok(!JSON.stringify(run()).includes('PRIVATE KEY'));
  assert.deepEqual(diagnoseCaChain(canary, trust, now), {
    schema: 'fdp-qa09-ca-chain/v1',
    completed: false,
    errorCode: 'SECRET_JSON_INVALID',
  });
});

test('receipt gate accepts completed diagnostic with invalid chain, rejects data leak and missing cleanup', async () => {
  const { validateCaDiagnostic } = await import('./check-qa09-ca-chain-diagnostic.mjs');
  const { createHash } = await import('node:crypto');
  const source = Buffer.from('synthetic source');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  const { caCertificateChainPem: omitted, ...incomplete } = secret;
  assert.ok(omitted);
  const receipt = {
    gate: 'PASS',
    finishedAt: now.toISOString(),
    scope: 'AWS_ONLY_READ_ONLY_CA_CHAIN_DIAGNOSTIC',
    account: '065986019555',
    region: 'ap-southeast-1',
    roleArn: 'arn:aws:iam::065986019555:role/fdp-test-onboarding-provisioning-role',
    secretValuesExported: false,
    privateKeysExported: false,
    secretWrites: false,
    businessWrites: false,
    temporaryCaPolicyApplied: true,
    createdFunctionVersion: '1',
    invocation: { StatusCode: 200, ExecutedVersion: '1' },
    cleanup: ['diagnostic-function', 'temporary-ca-policy', 'original-worker-policy-and-boundary'].map((type) => ({
      type,
      result: 'PASS',
    })),
    sourceBase64: source.toString('base64'),
    sourceHash,
    handlerSourceBase64: source.toString('base64'),
    handlerHash: sourceHash,
    truststore: {
      uri: 's3://fdp-test-mtls-truststore-065986019555/truststore/ca-bundle.pem',
      version: 'test-version',
      sha256: sourceHash,
    },
    requestNonce: 'test-nonce',
    result: {
      ...run(incomplete),
      requestNonce: 'test-nonce',
      sourceHash,
      secretVersionId: '0123456789abcdef0123456789abcdef',
      diagnosedAt: now.toISOString(),
    },
  };
  assert.equal(validateCaDiagnostic(receipt).workerChainValid, false);
  assert.throws(() => validateCaDiagnostic({ ...receipt, cleanup: receipt.cleanup.slice(1) }));
  assert.throws(() =>
    validateCaDiagnostic({ ...receipt, result: { ...receipt.result, caPrivateKeyPem: intermediate.privateKey } }),
  );
  assert.throws(() =>
    validateCaDiagnostic({ ...receipt, result: { ...receipt.result, findings: ['untrusted-secret-canary'] } }),
  );
});
