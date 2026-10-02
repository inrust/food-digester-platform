import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const fingerprint = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const allowedFindings = new Set([
  'REQUIRED_SECRET_FIELD_MISSING',
  'PUBLIC_CHAIN_UNPARSEABLE_OR_EMPTY',
  'WORKER_CHAIN_TOO_LONG',
  'NON_CA_CERTIFICATE',
  'CERTIFICATE_OUTSIDE_VALIDITY',
  'CHAIN_PARENT_OR_SIGNATURE_INVALID',
  'TERMINAL_CERTIFICATE_NOT_SELF_SIGNED',
  'PRIVATE_KEY_UNPARSEABLE',
  'SIGNING_KEY_MISMATCH',
]);
function demand(ok) {
  if (!ok) throw Error('CA_DIAGNOSTIC_NOT_VERIFIED');
}
function exactKeys(object, names) {
  demand(object && Object.keys(object).length === names.length && names.every((n) => Object.hasOwn(object, n)));
}
export function validateCaDiagnostic(receipt) {
  demand(receipt.gate === 'PASS' && receipt.finishedAt && receipt.scope === 'AWS_ONLY_READ_ONLY_CA_CHAIN_DIAGNOSTIC');
  demand(
    receipt.account === '065986019555' &&
      receipt.region === 'ap-southeast-1' &&
      receipt.roleArn === 'arn:aws:iam::065986019555:role/fdp-test-onboarding-provisioning-role',
  );
  demand(
    receipt.secretValuesExported === false &&
      receipt.privateKeysExported === false &&
      receipt.secretWrites === false &&
      receipt.businessWrites === false,
  );
  demand(receipt.temporaryCaPolicyApplied === true && receipt.createdFunctionVersion === '1');
  demand(
    receipt.invocation?.StatusCode === 200 &&
      receipt.invocation.ExecutedVersion === '1' &&
      !receipt.invocation.FunctionError,
  );
  demand(
    receipt.cleanup.length === 3 &&
      ['diagnostic-function', 'temporary-ca-policy', 'original-worker-policy-and-boundary'].every((type) =>
        receipt.cleanup.some((c) => c.type === type && c.result === 'PASS'),
      ),
  );
  demand(
    digest(Buffer.from(receipt.sourceBase64, 'base64')) === receipt.sourceHash &&
      digest(Buffer.from(receipt.handlerSourceBase64, 'base64')) === receipt.handlerHash,
  );
  demand(
    receipt.truststore.uri === 's3://fdp-test-mtls-truststore-065986019555/truststore/ca-bundle.pem' &&
      receipt.truststore.version &&
      /^[a-f0-9]{64}$/.test(receipt.truststore.sha256),
  );
  const r = receipt.result;
  const keys = [
    'schema',
    'completed',
    'fields',
    'configuredChainParseable',
    'configuredChainCount',
    'configuredChain',
    'workerChainValid',
    'privateKeyParseable',
    'privateKeyMatchesSigningCertificate',
    'signingCertificateFingerprint256',
    'truststoreParseable',
    'truststoreChainCount',
    'truststoreChain',
    'truststoreChainValid',
    'configuredChainEqualsTruststoreInOrder',
    'signingCertificateMatchesTruststoreFirst',
    'privateKeyMatchesTruststoreFirstCertificate',
    'missingTruststoreFingerprints',
    'findings',
    'requestNonce',
    'sourceHash',
    'secretVersionId',
    'diagnosedAt',
  ];
  exactKeys(r, keys);
  demand(
    r.schema === 'fdp-qa09-ca-chain/v1' &&
      r.completed === true &&
      r.requestNonce === receipt.requestNonce &&
      r.sourceHash === receipt.sourceHash,
  );
  demand(/^[a-zA-Z0-9_-]{32,64}$/.test(r.secretVersionId) && Number.isFinite(Date.parse(r.diagnosedAt)));
  exactKeys(r.fields, ['caCertificatePemPresent', 'caPrivateKeyPemPresent', 'caCertificateChainPemPresent']);
  demand(Object.values(r.fields).every((v) => typeof v === 'boolean'));
  for (const key of [
    'configuredChainParseable',
    'workerChainValid',
    'privateKeyParseable',
    'privateKeyMatchesSigningCertificate',
    'truststoreParseable',
    'truststoreChainValid',
    'configuredChainEqualsTruststoreInOrder',
    'signingCertificateMatchesTruststoreFirst',
    'privateKeyMatchesTruststoreFirstCertificate',
  ])
    demand(typeof r[key] === 'boolean');
  for (const [chain, count] of [
    [r.configuredChain, r.configuredChainCount],
    [r.truststoreChain, r.truststoreChainCount],
  ]) {
    demand(Array.isArray(chain) && chain.length === count && count <= 8);
    chain.forEach((c, index) => {
      exactKeys(c, [
        'index',
        'fingerprint256',
        'ca',
        'validFrom',
        'validTo',
        'currentlyValid',
        'issuerMatchesParent',
        'signatureValidWithParent',
        'selfIssued',
        'selfSignatureValid',
      ]);
      demand(
        c.index === index &&
          fingerprint.test(c.fingerprint256) &&
          Number.isFinite(Date.parse(c.validFrom)) &&
          Number.isFinite(Date.parse(c.validTo)),
      );
      demand(
        [
          'ca',
          'currentlyValid',
          'issuerMatchesParent',
          'signatureValidWithParent',
          'selfIssued',
          'selfSignatureValid',
        ].every((k) => typeof c[k] === 'boolean'),
      );
    });
  }
  demand(r.signingCertificateFingerprint256 === null || fingerprint.test(r.signingCertificateFingerprint256));
  demand(
    Array.isArray(r.missingTruststoreFingerprints) && r.missingTruststoreFingerprints.every((f) => fingerprint.test(f)),
  );
  demand(Array.isArray(r.findings) && r.findings.every((f) => allowedFindings.has(f)));
  return {
    task: 'QA-09',
    scope: 'AWS_ONLY_READ_ONLY_CA_CHAIN_DIAGNOSTIC',
    gate: 'PASS',
    functionDeleted: true,
    temporaryCaPolicyRevoked: true,
    workerChainValid: r.workerChainValid,
    truststoreChainValid: r.truststoreChainValid,
    findings: r.findings,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result;
  try {
    result = validateCaDiagnostic(JSON.parse(readFileSync(process.argv[2])));
  } catch {
    result = {
      task: 'QA-09',
      scope: 'AWS_ONLY_READ_ONLY_CA_CHAIN_DIAGNOSTIC',
      gate: 'FAIL',
      code: 'CA_DIAGNOSTIC_NOT_VERIFIED',
      fullQa09Accepted: false,
    };
  }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  process.exitCode = result.gate === 'PASS' ? 0 : 1;
}
