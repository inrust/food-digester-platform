import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ACCEPTANCE_COMMIT } from './collect-qa09-application-version.mjs';
import { assertOwnCloudDevice } from './qa09-ten-device-db.mjs';
export function validateTenDevice(receipt, version, dbReceipts, executor) {
  if (
    receipt.scope !== 'TEN_DEVICE_CSR_MTLS_HEARTBEAT_TELEMETRY_ARCHIVE' ||
    receipt.gate !== 'PASS' ||
    !receipt.finishedAt ||
    receipt.fullQa09Accepted !== false ||
    receipt.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
    receipt.sourceCommit !== ACCEPTANCE_COMMIT ||
    createHash('sha256').update(executor).digest('hex') !== receipt.executorSha256
  )
    throw Error('EXECUTION_NOT_VERIFIED');
  if (
    version.accountId !== '065986019555' ||
    version.region !== 'ap-southeast-1' ||
    version.stackName !== 'fdp-test-app' ||
    version.gate !== 'PASS' ||
    version.sourceCommit !== receipt.sourceCommit ||
    version.github.headSha !== receipt.sourceCommit ||
    version.github.conclusion !== 'success' ||
    version.ci.conclusion !== 'success' ||
    version.lambdaArtifacts.length < 10 ||
    version.lambdaArtifacts.some((a) => !a.matches || a.artifactSha256 !== a.codeSha256)
  )
    throw Error('APPLICATION_VERSION_NOT_VERIFIED');
  if (receipt.devices.length !== 10 || new Set(receipt.devices).size !== 10 || receipt.customers.length !== 2)
    throw Error('TEN_DEVICE_DUAL_CUSTOMER_REQUIRED');
  for (const id of receipt.devices) assertOwnCloudDevice(id, receipt.prefix);
  const checks = new Map(receipt.checks.map((c) => [c.id, c]));
  if (receipt.checks.some((c) => c.result !== 'PASS')) throw Error('FAILED_CLOUD_CHECK');
  for (const id of receipt.devices)
    for (const suffix of [
      'csr-create',
      'admin-detail',
      'approve',
      'csr-key-certificate-match',
      'target-endpoints',
      'real-mtls-sync',
    ])
      if (checks.get(id + ':' + suffix)?.result !== 'PASS') throw Error('MISSING_DEVICE_PROBE');
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
    if (checks.get(id)?.result !== 'PASS') throw Error('MISSING_LINK_PROBE');
  const keys = checks.get('ten-concurrent-independent-mqtt-sessions').keyFingerprints;
  if (keys?.length !== 10 || new Set(keys).size !== 10 || keys.some((k) => !/^[a-f0-9]{64}$/.test(k)))
    throw Error('INDEPENDENT_KEYS_NOT_VERIFIED');
  if (
    receipt.published.length !== 30 ||
    receipt.published.some(
      (p) =>
        !receipt.devices.includes(p.deviceId) ||
        !['heartbeat', 'telemetry'].includes(p.type) ||
        !/^[a-f0-9]{64}$/.test(p.bodySha256),
    )
  )
    throw Error('PUBLISH_LEDGER_NOT_VERIFIED');
  const complete = dbReceipts.filter((r) => r.result?.action === 'observe').at(-1)?.result;
  if (
    !complete ||
    complete.devices.length !== 10 ||
    complete.devices.some((d) => d.lifecycle_status !== 'Onboarded') ||
    complete.certificates.length !== 10 ||
    complete.certificates.some(
      (c) => c.status !== 'ACTIVE' || !c.package_destroyed || !c.mqtt_verified_at || !c.rest_verified_at,
    ) ||
    complete.receipts.length !== 30 ||
    complete.receipts.some((r) => r.result !== 'PROCESSED')
  )
    throw Error('DATABASE_LINK_NOT_VERIFIED');
  if (complete.telemetrySamples?.length !== 10 || complete.telemetrySamples.some((t) => t.samples !== '2'))
    throw Error('DUPLICATE_BUSINESS_ROWS');
  for (const p of receipt.published) {
    const row = complete.receipts.find((r) => r.device_id === p.deviceId && r.topic_type === p.type && r.seq === p.seq);
    if (!row || row.payload_hash !== p.payloadSha256) throw Error('PUBLISHED_INGRESS_PAYLOAD_MISMATCH');
    if (p.type === 'telemetry') {
      const outbox = complete.outbox.find(
        (o) => o.messageId === p.messageId && o.topicType === p.type && o.status === 'PUBLISHED',
      );
      const archive = outbox && checks.get('archive-original-' + outbox.id);
      if (!archive || archive.rawBodySha256 !== outbox.rawBodySha256 || archive.payloadSha256 !== p.payloadSha256)
        throw Error('ARCHIVE_ORIGINAL_NOT_VERIFIED');
    }
  }
  const seed = dbReceipts.find((r) => r.result?.action === 'seed');
  const cleanup = dbReceipts.find((r) => r.result?.action === 'cleanup');
  if (
    !seed ||
    JSON.stringify(seed.result.originalFingerprints) !== JSON.stringify(cleanup?.result.originalFingerprints) ||
    !cleanup ||
    cleanup.result.deleted.devices !== 10 ||
    dbReceipts.some(
      (r) =>
        r.gate !== 'PASS' ||
        r.result.prefix !== receipt.prefix ||
        r.result.buildId !== r.build.id ||
        r.result.sourceHash !== r.sourceHash,
    ) ||
    receipt.cleanup.some((c) => c.result !== 'PASS') ||
    receipt.cleanup.filter((c) => c.type === 'iot-certificate').length !== 10 ||
    receipt.cleanup.filter((c) => c.type === 'customer').length !== 2 ||
    receipt.cleanup.filter((c) => c.type === 'identity').length !== 1
  )
    throw Error('CLEANUP_NOT_VERIFIED');
  if (
    !receipt.archiveObjects.length ||
    receipt.archiveObjects.some(
      (o) =>
        !/^raw\/(topic_type=heartbeat|topic_type=telemetry)\//.test(o.key) ||
        !/^[a-f0-9]{64}$/.test(o.compressedSha256),
    ) ||
    receipt.archiveKeys.some(
      (key) => !receipt.cleanup.some((c) => c.type === 'archive-object' && c.key === key && c.result === 'PASS'),
    )
  )
    throw Error('ARCHIVE_NOT_VERIFIED');
  return {
    task: 'QA-09',
    scope: receipt.scope,
    gate: 'PASS',
    sourceCommit: receipt.sourceCommit,
    prefix: receipt.prefix,
    devices: 10,
    independentKeys: 10,
    uniqueMessages: 30,
    cloudChecks: receipt.checks.length,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [input, output] = process.argv.slice(2);
    const receipt = JSON.parse(readFileSync(input));
    const version = JSON.parse(readFileSync(receipt.artifactByteReceipt ?? receipt.versionReceipt));
    const db = receipt.databaseBuilds.map((b) => JSON.parse(readFileSync(b.receipt)));
    const result = validateTenDevice(
      receipt,
      version,
      db,
      readFileSync(new URL('./run-qa09-ten-device-acceptance.mjs', import.meta.url)),
    );
    if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } catch (e) {
    const reason = /^[A-Z][A-Z0-9_]{1,80}$/.test(e.message) ? e.message : 'GATE_INPUT_NOT_VERIFIED';
    if (process.argv[3])
      writeFileSync(
        process.argv[3],
        JSON.stringify({ task: 'QA-09', gate: 'FAIL', reason, fullQa09Accepted: false }, null, 2) + '\n',
      );
    console.error(reason);
    process.exitCode = 1;
  }
}
