import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBusinessDatabaseReceipts,
  validateBusinessVersion,
  mqttBurstWindow,
} from './check-qa09-business-target.mjs';
import { CURRENT_TEST_CONFIG, validateCurrentEnvironment } from './qa09-current-environment.mjs';

test('nominal 30x profile cannot conceal a slower real publish window', () => {
  const published = Array.from({ length: 300 }, (_, i) => ({
    stage: 'burst',
    type: 'telemetry',
    deviceId: `d${i % 10}`,
    seq: Math.floor(i / 10) + 1,
    payloadSha256: `hash${i}`,
  }));
  const r = { mqttLoad: { published, plan: { burstMultiplier: 30, burstSeconds: 10 } } };
  const records = (seconds) => [
    {
      result: {
        action: 'observe',
        receipts: published.map((p, i) => ({
          device_id: p.deviceId,
          topic_type: p.type,
          seq: p.seq,
          payload_hash: p.payloadSha256,
          result: 'PROCESSED',
          occurred_at: new Date(Date.parse('2026-10-03T00:00:00Z') + ((i * seconds) / 299) * 1000).toISOString(),
        })),
      },
    },
  ];
  assert.equal(mqttBurstWindow(r, records(9.9)).gate, 'PASS');
  assert.equal(mqttBurstWindow(r, records(150)).gate, 'FAIL');
  const invalid = records(9.9);
  invalid[0].result.receipts[0].payload_hash = 'foreign';
  assert.throws(() => mqttBurstWindow(r, invalid), /BURST_DELIVERY_NOT_BOUND/);
});

test('version proof requires CI deploy Amplify exact commit and 19 distinct verified artifact bytes', () => {
  const commit = 'a'.repeat(40),
    digest = Buffer.alloc(32).toString('base64');
  const version = {
    gate: 'PASS',
    sourceCommit: commit,
    accountId: '065986019555',
    region: 'ap-southeast-1',
    stackName: 'fdp-test-app',
    github: { headSha: commit, conclusion: 'success', status: 'completed' },
    ci: { headSha: commit, conclusion: 'success', status: 'completed' },
    amplify: [{ commitId: commit, status: 'SUCCEED' }],
    lambdaArtifacts: Array.from({ length: 19 }, (_, i) => ({
      name: `fn${i}`,
      matches: true,
      codeSha256: digest,
      artifactSha256: digest,
    })),
  };
  validateBusinessVersion(version, commit);
  for (const mutate of [
    (v) => {
      v.ci.headSha = 'b'.repeat(40);
    },
    (v) => {
      v.github.status = 'in_progress';
    },
    (v) => {
      v.amplify[0].commitId = 'b'.repeat(40);
    },
    (v) => {
      v.lambdaArtifacts[1].name = v.lambdaArtifacts[0].name;
    },
    (v) => {
      v.lambdaArtifacts[0].artifactSha256 = 'wrong';
    },
    (v) => {
      v.lambdaArtifacts[0].matches = false;
    },
  ]) {
    const changed = structuredClone(version);
    mutate(changed);
    assert.throws(() => validateBusinessVersion(changed, commit));
  }
});

test('own-fixture fault grant rejects shared changes and unknown faults while retaining deployment boundary', () => {
  validateCurrentEnvironment(CURRENT_TEST_CONFIG);
  for (const change of [
    (c) => {
      c.authorization.ownFixtureFaults.sharedResourceChanges = true;
    },
    (c) => {
      c.authorization.ownFixtureFaults.actions.push('PAUSE_SHARED_LAMBDA');
    },
    (c) => {
      c.authorization.ownFixtureFaults.restoreAndAuditRequired = false;
    },
    (c) => {
      c.authorization.cloudDeployment = true;
    },
  ]) {
    const c = structuredClone(CURRENT_TEST_CONFIG);
    change(c);
    assert.throws(() => validateCurrentEnvironment(c));
  }
});

test('database proof rejects foreign build, source, role and nonzero cleanup instead of trusting child PASS', () => {
  const sourceHash = 'a'.repeat(64),
    prefix = 'qa09-1234567890abcdef';
  const actions = ['business-baseline', 'business-cleanup', 'business-audit'];
  const r = {
    prefix,
    sourceHashes: { 'scripts/qa09-ten-device-db.mjs': sourceHash },
    databaseBuilds: actions.map((action, i) => ({ action, buildId: `build-${i}` })),
  };
  const receipts = actions.map((action, i) => ({
    gate: 'PASS',
    sourceHash,
    build: {
      id: `build-${i}`,
      status: 'SUCCEEDED',
      serviceRole: 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role',
    },
    result: {
      gate: 'PASS',
      prefix,
      sourceHash,
      buildId: `build-${i}`,
      action,
      businessFingerprints: [{ table: 'licenses', count: '1', digest: 'original' }],
      counts: { licenses: 0 },
    },
  }));
  validateBusinessDatabaseReceipts(r, receipts);
  assert.throws(() => validateBusinessDatabaseReceipts(r, []), /DATABASE_RECEIPTS_MISSING/);
  for (const mutate of [
    (x) => {
      x[2].build.id = 'foreign';
    },
    (x) => {
      x[2].result.sourceHash = 'b'.repeat(64);
    },
    (x) => {
      x[2].result.prefix = 'qa09-ffffffffffffffff';
    },
    (x) => {
      x[2].build.serviceRole = 'foreign';
    },
    (x) => {
      x[2].result.counts.licenses = 1;
    },
    (x) => {
      x[2].result.businessFingerprints[0].digest = 'changed';
    },
  ]) {
    const altered = structuredClone(receipts);
    mutate(altered);
    assert.throws(() => validateBusinessDatabaseReceipts(r, altered));
  }
});
