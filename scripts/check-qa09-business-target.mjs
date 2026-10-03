import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertBusinessContext, ROLES, validateTargetStage } from './qa09-business-target.mjs';
const required = {
  core: [
    'core-workflows-complete',
    'contract-if-match-race',
    'license-issue',
    'license-activate',
    'license-renew',
    'license-revoke',
    'config-publish',
    'device-user-disable',
    'consumable-complete',
    'consumable-cancel',
    'alarm-clear',
  ],
  security: [
    'invalid-writes-no-business-effects',
    'audit-no-credential-leak',
    'invite-password-rejected',
    'security-required-probes-complete',
  ],
  recovery: ['own-export-lease-expired', 'expired-processing-lease-recovered', 'esg-export-csv-count'],
  browser: ['browser-site-edit-persisted', 'browser-required-probes-complete'],
  httpLoad: ['http-ten-client-load'],
  mqttLoad: [
    'quick-mqtt-published',
    'quick-mqtt-no-extra-business-samples',
    'quick-mqtt-ingestion-processed',
    'quick-mqtt-archives-consistent',
    'mqtt-load-required-probes-complete',
  ],
};
export function validateBusinessVersion(version, commit) {
  if (
    version.gate !== 'PASS' ||
    version.sourceCommit !== commit ||
    version.accountId !== '065986019555' ||
    version.region !== 'ap-southeast-1' ||
    version.stackName !== 'fdp-test-app' ||
    version.github?.headSha !== commit ||
    version.github.conclusion !== 'success' ||
    version.github.status !== 'completed' ||
    version.ci?.headSha !== commit ||
    version.ci.conclusion !== 'success' ||
    version.ci.status !== 'completed' ||
    version.amplify?.[0]?.commitId !== commit ||
    version.amplify[0].status !== 'SUCCEED' ||
    !Array.isArray(version.lambdaArtifacts) ||
    version.lambdaArtifacts.length !== 19 ||
    new Set(version.lambdaArtifacts.map((a) => a.name)).size !== 19 ||
    version.lambdaArtifacts.some(
      (a) => !a.matches || !/^[A-Za-z0-9+/]{43}=$/.test(a.codeSha256) || a.codeSha256 !== a.artifactSha256,
    )
  )
    throw Error('APPLICATION_VERSION_NOT_INDEPENDENTLY_BOUND');
}
export function mqttBurstWindow(r, receipts) {
  const expected = r.mqttLoad?.published?.filter((p) => p.stage === 'burst' && p.type === 'telemetry');
  const observed = receipts.findLast((d) => d.result.action === 'observe')?.result.receipts;
  if (expected?.length !== 300 || !observed) throw Error('BURST_DELIVERY_TIME_PROOF_MISSING');
  const timestamps = expected.map((p) => {
    const actual = observed.find((x) => x.device_id === p.deviceId && x.topic_type === p.type && x.seq === p.seq);
    if (!actual || actual.payload_hash !== p.payloadSha256 || actual.result !== 'PROCESSED')
      throw Error('BURST_DELIVERY_NOT_BOUND');
    return Date.parse(actual.occurred_at);
  });
  if (timestamps.some((t) => !Number.isFinite(t))) throw Error('BURST_DELIVERY_TIME_PROOF_MISSING');
  // Archived executor constructs normal/burst meta.ts immediately before each publish call.
  // Thus this is a lower bound on publish duration, not PUBACK or end-to-end API latency.
  const spanSeconds = (Math.max(...timestamps) - Math.min(...timestamps)) / 1000;
  return {
    messages: 300,
    publishStartSpanSeconds: spanSeconds,
    targetSeconds: 10,
    schedulingToleranceSeconds: 1,
    gate: spanSeconds <= 11 ? 'PASS' : 'FAIL',
    proof: 'CLIENT_PAYLOAD_CREATION_TIMES_BOUND_TO_PROCESSED_RDS_HASHES_NOT_PUBACK_SLO',
  };
}
export function validateBusinessDatabaseReceipts(r, receipts) {
  if (!Array.isArray(receipts) || receipts.length !== r.databaseBuilds.length || !receipts.length)
    throw Error('DATABASE_RECEIPTS_MISSING');
  for (const [i, d] of receipts.entries()) {
    const expected = r.databaseBuilds[i];
    if (
      d.gate !== 'PASS' ||
      d.build?.status !== 'SUCCEEDED' ||
      d.build.id !== expected.buildId ||
      d.result?.buildId !== expected.buildId ||
      d.build.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' ||
      d.result.action !== expected.action ||
      d.result.prefix !== r.prefix ||
      d.sourceHash !== r.sourceHashes['scripts/qa09-ten-device-db.mjs'] ||
      d.result.sourceHash !== d.sourceHash ||
      d.result.gate !== 'PASS'
    )
      throw Error('DATABASE_RECEIPT_NOT_BOUND');
  }
  const baseline = receipts.find((d) => d.result.action === 'business-baseline')?.result.businessFingerprints;
  const audit = receipts.findLast((d) => d.result.action === 'business-audit')?.result;
  if (
    !baseline?.length ||
    !audit ||
    !Object.keys(audit.counts ?? {}).length ||
    Object.values(audit.counts).some((n) => n !== 0) ||
    JSON.stringify(baseline) !== JSON.stringify(audit.businessFingerprints)
  )
    throw Error('BUSINESS_CLEANUP_NOT_INDEPENDENTLY_VERIFIED');
}
export function validateBusinessTarget(r, parent, version, sources, databaseReceipts) {
  assertBusinessContext(r);
  validateBusinessVersion(version, r.sourceCommit);
  validateBusinessDatabaseReceipts(r, databaseReceipts);
  if (
    r.prefix !== parent.prefix ||
    parent.sourceCommit !== r.sourceCommit ||
    JSON.stringify(parent.devices) !== JSON.stringify(r.devices) ||
    JSON.stringify(parent.customers.map((c) => ({ id: c.id, name: c.name }))) !==
      JSON.stringify(r.customers.map((c) => ({ id: c.id, name: c.name }))) ||
    r.sourceCommit !== version.sourceCommit ||
    version.gate !== 'PASS' ||
    parent.target.accountId !== '065986019555' ||
    parent.target.region !== 'ap-southeast-1' ||
    version.lambdaArtifacts.length !== 19 ||
    version.lambdaArtifacts.some((a) => !a.matches) ||
    !parent.finishedAt ||
    parent.gate !== 'PASS' ||
    !parent.cleanup.length ||
    parent.cleanup.some((c) => c.result !== 'PASS')
  )
    throw Error('APPLICATION_OR_PARENT_CLEANUP_NOT_VERIFIED');
  for (const path of [
    'scripts/run-qa09-business-target.mjs',
    'scripts/qa09-business-target.mjs',
    'scripts/qa09-mqtt-load-target.mjs',
    'scripts/run-qa09-ten-device-acceptance.mjs',
    'scripts/qa09-ten-device-db.mjs',
  ])
    if (!sources.sources.some((s) => s.path === path)) throw Error('EXECUTION_SOURCE_MISSING');
  for (const id of [
    'dedicated-real-srp',
    'ten-concurrent-independent-mqtt-sessions',
    'first-heartbeat-completes-ten-onboardings',
    'rest-no-client-certificate-denied',
    'rest-untrusted-client-certificate-denied',
    'aws-cross-device-subscription-denied',
    'aws-cross-device-publish-denied',
    'all-twenty-telemetry-archived',
  ])
    if (!parent.checks.some((c) => c.id === id && c.result === 'PASS'))
      throw Error('REAL_DEVICE_BASELINE_PROOF_MISSING');
  const keys = parent.checks.find((c) => c.id === 'ten-concurrent-independent-mqtt-sessions').keyFingerprints;
  if (
    keys?.length !== 10 ||
    new Set(keys).size !== 10 ||
    parent.cleanup.filter((c) => c.type === 'iot-certificate').length !== 10 ||
    !parent.cleanup.some((c) => c.type === 'database-fixtures' && c.count === 10) ||
    parent.cleanup.filter((c) => c.type === 'customer').length !== 2 ||
    !parent.cleanup.some(
      (c) => c.type === 'identity' && c.username === r.prefix + '-platformsuperadmin@example.invalid',
    )
  )
    throw Error('OWN_DEVICE_IDENTITY_CLEANUP_INCOMPLETE');
  for (const source of sources.sources) {
    if (createHash('sha256').update(Buffer.from(source.sourceBase64, 'base64')).digest('hex') !== source.sha256)
      throw Error('EXECUTION_SOURCE_CORRUPTED');
  }
  if (
    sources.sources.find((s) => s.path === 'scripts/run-qa09-ten-device-acceptance.mjs').sha256 !==
    parent.executorSha256
  )
    throw Error('PARENT_EXECUTOR_NOT_BOUND');
  for (const [path, hash] of Object.entries(r.sourceHashes)) {
    const found = sources.sources.find((s) => s.path === path) ?? r.sources.find((s) => s.path === path);
    if (
      !found ||
      found.sha256 !== hash ||
      createHash('sha256').update(Buffer.from(found.sourceBase64, 'base64')).digest('hex') !== hash
    )
      throw Error('TARGET_SOURCE_NOT_BOUND');
  }
  const stages = {};
  for (const [stage, ids] of Object.entries(required)) {
    try {
      stages[stage] = validateTargetStage(r, stage, ids);
    } catch {
      stages[stage] = { stage, gate: 'FAIL', reason: 'REQUIRED_TARGET_PROOF_OR_CLEANUP_MISSING' };
    }
  }
  for (const role of ROLES) {
    const own = r.checks.find((c) => c.id === role + ':device-scope:0'),
      cross = r.checks.find((c) => c.id === role + ':device-scope:1');
    if (own?.status !== 200 || cross?.status !== (role.startsWith('Customer') ? 403 : 200)) {
      stages.core.gate = 'FAIL';
      stages.core.reason = 'FIVE_ROLE_TENANT_MATRIX_INCOMPLETE';
    }
  }
  for (const role of ROLES)
    if (!r.checks.some((c) => c.id === role + ':browser-srp-login' && c.result === 'PASS')) {
      stages.browser.gate = 'FAIL';
      stages.browser.reason = 'REAL_BROWSER_FIVE_ROLE_LOGIN_INCOMPLETE';
    }
  let burst;
  try {
    burst = mqttBurstWindow(r, databaseReceipts);
    if (burst.gate !== 'PASS') throw Error('REAL_BURST_RATE_NOT_PROVED');
  } catch (e) {
    stages.mqttLoad.gate = 'FAIL';
    stages.mqttLoad.reason = /^[A-Z_]+$/.test(e.message) ? e.message : 'REAL_BURST_RATE_NOT_PROVED';
  }
  return {
    task: 'QA-09',
    scope: r.scope,
    gate: Object.values(stages).every((s) => s.gate === 'PASS') ? 'PASS' : 'PARTIAL',
    sourceCommit: r.sourceCommit,
    prefix: r.prefix,
    stages,
    fullQa09Accepted: false,
    remainingCoverage: r.remainingCoverage,
    cleanup: r.cleanupComplete ? 'PASS' : 'FAIL',
    mqttBurst: burst,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const file = process.argv[2];
  let result;
  try {
    const r = JSON.parse(readFileSync(file)),
      p = JSON.parse(readFileSync(file + '.devices.json'));
    result = validateBusinessTarget(
      r,
      p,
      JSON.parse(readFileSync(p.versionReceipt)),
      JSON.parse(readFileSync(file + '.sources.json')),
      r.databaseBuilds.map((d) => JSON.parse(readFileSync(d.receipt))),
    );
  } catch (e) {
    result = {
      task: 'QA-09',
      gate: 'FAIL',
      reason: /^[A-Z_]+$/.test(e.message) ? e.message : 'TARGET_INPUT_NOT_VERIFIED',
      fullQa09Accepted: false,
    };
  }
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
  process.exitCode = result.gate === 'PASS' ? 0 : 1;
}
