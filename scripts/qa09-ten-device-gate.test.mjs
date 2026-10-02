import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateTenDevice } from './check-qa09-ten-device-acceptance.mjs';
const source = Buffer.from('test executor bytes'),
  sha = 'a'.repeat(64),
  prefix = 'qa09-1234567890abcdef';
function fixture() {
  const devices = Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`);
  const checks = devices.flatMap((id) =>
    ['csr-create', 'admin-detail', 'approve', 'csr-key-certificate-match', 'target-endpoints', 'real-mtls-sync'].map(
      (s) => ({ id: id + ':' + s, result: 'PASS' }),
    ),
  );
  for (const id of [
    'dedicated-real-srp',
    'ten-concurrent-independent-mqtt-sessions',
    'first-heartbeat-completes-ten-onboardings',
    'ten-active-packages-destroyed',
    'claimed-certificate-identities-match-rds',
    'rest-no-client-certificate-denied',
    'rest-untrusted-client-certificate-denied',
    'exactly-thirty-unique-ingestion-receipts',
    'all-mqtt-and-rest-proofs-recorded',
    'exactly-two-business-samples-per-device',
    'telemetry-outbox-published',
    'all-twenty-telemetry-archived',
    'aws-cross-device-subscription-denied',
    'aws-cross-device-publish-denied',
  ])
    checks.push({ id, result: 'PASS' });
  checks.find((c) => c.id === 'ten-concurrent-independent-mqtt-sessions').keyFingerprints = devices.map((id) =>
    createHash('sha256').update(id).digest('hex'),
  );
  const published = devices.flatMap((deviceId) =>
    [
      ['heartbeat', 1],
      ['telemetry', 1],
      ['telemetry', 2],
    ].map(([type, seq]) => ({
      deviceId,
      type,
      seq,
      messageId: `${deviceId}-${type}-${seq}`,
      bodySha256: sha,
      payloadSha256: sha,
    })),
  );
  const outbox = published
    .filter((p) => p.type === 'telemetry')
    .map((p) => ({
      id: p.messageId,
      messageId: p.messageId,
      topicType: p.type,
      status: 'PUBLISHED',
      rawBodySha256: sha,
    }));
  for (const o of outbox)
    checks.push({ id: 'archive-original-' + o.id, result: 'PASS', rawBodySha256: sha, payloadSha256: sha });
  const db = [
    {
      gate: 'PASS',
      sourceHash: sha,
      build: { id: 'seed' },
      result: { action: 'seed', prefix, sourceHash: sha, buildId: 'seed', originalFingerprints: [] },
    },
    {
      gate: 'PASS',
      sourceHash: sha,
      build: { id: 'observe' },
      result: {
        action: 'observe',
        prefix,
        sourceHash: sha,
        buildId: 'observe',
        devices: devices.map((id) => ({ id, lifecycle_status: 'Onboarded' })),
        certificates: devices.map((device_id) => ({
          device_id,
          status: 'ACTIVE',
          package_destroyed: true,
          mqtt_verified_at: '2026-10-02',
          rest_verified_at: '2026-10-02',
        })),
        receipts: published.map((p) => ({
          device_id: p.deviceId,
          topic_type: p.type,
          seq: p.seq,
          payload_hash: sha,
          result: 'PROCESSED',
        })),
        telemetrySamples: devices.map((device_id) => ({ device_id, samples: '2' })),
        outbox,
      },
    },
    {
      gate: 'PASS',
      sourceHash: sha,
      build: { id: 'cleanup' },
      result: {
        action: 'cleanup',
        prefix,
        sourceHash: sha,
        buildId: 'cleanup',
        originalFingerprints: [],
        deleted: { devices: 10 },
      },
    },
  ];
  const key = 'raw/topic_type=telemetry/customer_id=owned/part-a.json.gz';
  const receipt = {
    gate: 'PASS',
    finishedAt: '2026-10-02',
    mode: 'REAL_EXISTING_TEST_ENVIRONMENT',
    sourceCommit: '46b632d66c9f6615b037790934eff434d22e4542',
    executorSha256: createHash('sha256').update(source).digest('hex'),
    fullQa09Accepted: false,
    scope: 'TEN_DEVICE_CSR_MTLS_HEARTBEAT_TELEMETRY_ARCHIVE',
    prefix,
    devices,
    customers: [{}, {}],
    checks,
    published,
    cleanup: [
      ...devices.map((id) => ({ type: 'iot-certificate', id, result: 'PASS' })),
      { type: 'identity', result: 'PASS' },
      { type: 'customer', result: 'PASS' },
      { type: 'customer', result: 'PASS' },
      { type: 'archive-object', key, result: 'PASS' },
    ],
    archiveKeys: [key],
    archiveObjects: [{ key, compressedSha256: sha }],
  };
  const version = {
    accountId: '065986019555',
    region: 'ap-southeast-1',
    stackName: 'fdp-test-app',
    gate: 'PASS',
    sourceCommit: receipt.sourceCommit,
    github: { headSha: receipt.sourceCommit, conclusion: 'success' },
    ci: { conclusion: 'success' },
    lambdaArtifacts: devices.map(() => ({ matches: true, artifactSha256: sha, codeSha256: sha })),
  };
  return { receipt, version, db };
}
test('complete narrow real-environment scope never accepts full QA09', () => {
  const f = fixture();
  assert.equal(validateTenDevice(f.receipt, f.version, f.db, source).fullQa09Accepted, false);
});
test('missing mTLS, shared keys, different ingress/archive bytes and missing cleanup fail closed', () => {
  for (const mode of ['mtls', 'key', 'ingress', 'archive', 'cleanup', 'version', 'executor']) {
    const f = fixture();
    if (mode === 'mtls') f.receipt.checks = f.receipt.checks.filter((c) => !c.id.endsWith(':real-mtls-sync'));
    if (mode === 'key') {
      const keys = f.receipt.checks.find((c) => c.id === 'ten-concurrent-independent-mqtt-sessions').keyFingerprints;
      keys[1] = keys[0];
    }
    if (mode === 'ingress') f.db[1].result.receipts[0].payload_hash = 'b'.repeat(64);
    if (mode === 'archive')
      f.receipt.checks.find((c) => c.id.startsWith('archive-original-')).rawBodySha256 = 'b'.repeat(64);
    if (mode === 'cleanup') f.receipt.cleanup.pop();
    if (mode === 'version') f.version.lambdaArtifacts[0].artifactSha256 = 'wrong';
    assert.throws(() =>
      validateTenDevice(f.receipt, f.version, f.db, mode === 'executor' ? Buffer.from('changed') : source),
    );
  }
});
