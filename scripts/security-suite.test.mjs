import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeExecution, summarizeEvidence, assertSafeArtifact, ADMIN_WRITES } from './run-security-suite.mjs';
import { QA06_FILES, QA06_REQUIRED_CASES } from './qa06-manifest.mjs';
import { scanSecurityArtifact } from './security-leak-scan.mjs';
function execution() {
  const testResults = QA06_FILES.map((file) => ({
    name: new URL(`../${file}`, import.meta.url).pathname,
    status: 'passed',
    assertionResults: QA06_REQUIRED_CASES.filter((c) => c.file === file)
      .map((c) => c.name)
      .filter((v, i, a) => a.indexOf(v) === i)
      .concat('supporting security regression')
      .map((fullName) => ({ fullName, status: 'passed' })),
  }));
  return {
    success: true,
    numFailedTests: 0,
    numPendingTests: 0,
    numPassedTests: testResults.reduce((n, r) => n + r.assertionResults.length, 0),
    testResults,
  };
}
function trace() {
  const proofs = [
    {
      name: 'jwt-integrity-time-replay',
      invalidClaimsRejected: 6,
      tamperedRejected: true,
      validReuse: true,
      unauthorizedStatuses: [401],
    },
    {
      name: 'all-admin-write-auth',
      resolverCalls: 0,
      matrix: ADMIN_WRITES.map((operationId) => ({ operationId, statuses: [401, 401, 401] })),
    },
    {
      name: 'tenant-sql-json',
      crossTenantStatus: 403,
      writeDenied: 403,
      noUnauthorizedWrites: true,
      jsonRejected: 7,
      sqlLiteralStored: true,
      sqlNoCrossScope: true,
      prototypeUnchanged: true,
    },
    { name: 'malicious-media', attacksRejected: 12, statuses: [400], signedUrls: 0, businessWrites: 0 },
    {
      name: 'sensitive-artifacts',
      logLevels: 4,
      traceScanned: true,
      auditScanned: true,
      snapshotScanned: true,
      sensitiveFindings: 0,
    },
  ].map((r, i) => ({
    kind: 'proof',
    status: 'PASS',
    cleanup: 'PASS',
    prefix: `QA06-${String(i + 1).padStart(12, '0')}`,
    ...r,
  }));
  return [
    ...proofs,
    ...Array.from({ length: ADMIN_WRITES.length * 3 }, () => ({
      kind: 'artifact',
      channel: 'response',
      inspectedNodes: 5,
      findings: [],
    })),
    ...['log', 'log', 'log', 'log', 'audit', 'snapshot'].map((channel) => ({
      kind: 'artifact',
      channel,
      inspectedNodes: 5,
      findings: [],
    })),
  ];
}
test('security receipt accepts complete execution and all observed acceptance proofs', () => {
  assert.ok(summarizeExecution(execution()).testCount > 0);
  assert.equal(summarizeEvidence(trace()).adminWriteOperations, ADMIN_WRITES.length);
});
for (const [name, mutate] of [
  [
    'deleted required test',
    (r) => {
      r.testResults.find((f) => f.name.endsWith('qa06-security.test.ts')).assertionResults.pop();
      r.testResults.find((f) => f.name.endsWith('qa06-security.test.ts')).assertionResults.shift();
    },
  ],
  [
    'missing file',
    (r) => {
      r.testResults.pop();
    },
  ],
  [
    'pending test',
    (r) => {
      r.numPendingTests = 1;
    },
  ],
  [
    'failed test',
    (r) => {
      r.testResults[0].assertionResults[0].status = 'failed';
    },
  ],
])
  test(`execution fails closed: ${name}`, () => {
    const r = execution();
    mutate(r);
    assert.throws(() => summarizeExecution(r));
  });
const probes = [
  [
    'missing proof',
    (r) => {
      r.shift();
    },
  ],
  [
    'reused prefix',
    (r) => {
      r[1].prefix = r[0].prefix;
    },
  ],
  [
    'cleanup incomplete',
    (r) => {
      r[0].cleanup = 'FAIL';
    },
  ],
  [
    'expired JWT accepted',
    (r) => {
      r[0].unauthorizedStatuses = [200];
    },
  ],
  [
    'missing write operation',
    (r) => {
      r[1].matrix.pop();
    },
  ],
  [
    'forged identity accepted',
    (r) => {
      r[1].matrix[0].statuses = [401, 401, 200];
    },
  ],
  [
    'route resolved before auth',
    (r) => {
      r[1].resolverCalls = 1;
    },
  ],
  [
    'cross tenant allowed',
    (r) => {
      r[2].crossTenantStatus = 200;
    },
  ],
  [
    'unauthorized side effect',
    (r) => {
      r[2].noUnauthorizedWrites = false;
    },
  ],
  [
    'prototype pollution',
    (r) => {
      r[2].prototypeUnchanged = false;
    },
  ],
  [
    'malicious media signed',
    (r) => {
      r[3].signedUrls = 1;
    },
  ],
  [
    'malicious media persisted',
    (r) => {
      r[3].businessWrites = 1;
    },
  ],
  [
    'leak ignored',
    (r) => {
      r[5].findings = [{ path: '$.value', rule: 'jwt' }];
    },
  ],
  [
    'unscanned audit',
    (r) => {
      return r.filter((x) => x.channel !== 'audit');
    },
  ],
  [
    'unscanned snapshot',
    (r) => {
      return r.filter((x) => x.channel !== 'snapshot');
    },
  ],
  [
    'partial response scan',
    (r) => {
      return r.filter((x) => x.channel !== 'response');
    },
  ],
];
for (const [name, mutate] of probes)
  test(`proof fails closed: ${name}`, () => {
    let rows = trace();
    rows = mutate(rows) ?? rows;
    assert.throws(() => summarizeEvidence(rows));
  });
test('independent scanner rejects nested secrets raw JWT Error private key and signed URL without echoing values', () => {
  const jwt = [
    Buffer.from('{"alg":"RS256"}').toString('base64url'),
    Buffer.from('{"sub":"qa06"}').toString('base64url'),
    'signature',
  ].join('.');
  const pem = [
    ['-----BEGIN', 'PRIVATE KEY-----'].join(' '),
    'synthetic',
    ['-----END', 'PRIVATE KEY-----'].join(' '),
  ].join('\n');
  const values = [
    { passwordHash: 'synthetic' },
    { nested: [{ value: jwt }] },
    new Error(`Bearer ${jwt}`),
    { note: pem },
    { url: 'https://s3.example.test/x?X-Amz-Signature=synthetic' },
  ];
  for (const value of values) {
    const scan = scanSecurityArtifact(value);
    assert.ok(scan.findings.length > 0);
    assert.ok(scan.inspectedNodes > 0);
    assert.throws(() => assertSafeArtifact(value), /UNREDACTED_SECURITY_RUN_ARTIFACT/);
    assert.ok(!JSON.stringify(scan).includes(jwt));
  }
});
test('scanner detects opaque canary leakage and permits null redacted values and public certificate', () => {
  assert.equal(
    scanSecurityArtifact({
      passwordHash: '[REDACTED]',
      privateKey: null,
      note: '-----BEGIN CERTIFICATE----- public -----END CERTIFICATE-----',
    }).findings.length,
    0,
  );
  assert.ok(scanSecurityArtifact({ note: 'opaque-synthetic-leak' }, ['opaque-synthetic-leak']).findings.length > 0);
});
