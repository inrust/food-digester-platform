import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  bindFile,
  validateTargetBindings,
  validateReceiptBinding,
  targetEnvironmentErrors,
  readBoundFile,
  contentSnapshot,
} from './qa09-acceptance-context.mjs';
import { checkAcceptanceEntry } from './check-qa09-acceptance.mjs';
import { REQUIRED_PROBES, checkAwsDataProcessingEvidence } from './check-aws-data-processing-evidence.mjs';

const root = new URL('..', import.meta.url).pathname;
const bindingPath = 'docs/audit/evidence/qa-09-a1-entry-2026-10-13/bindings.json';
const context = () => {
  const c = JSON.parse(readFileSync(resolve(root, bindingPath)));
  // Tests bind current executor/docs; sealed A1 receipts retain their historical content hashes.
  c.versions.executor = contentSnapshot(
    root,
    c.versions.executor.baseCommit,
    c.versions.executor.files.map((r) => r.path),
  );
  c.versions.documentation = contentSnapshot(
    root,
    c.versions.documentation.baseCommit,
    c.versions.documentation.files.map((r) => r.path),
  );
  return c;
};
function fixture(action) {
  mkdirSync(resolve(root, 'build'), { recursive: true });
  const directory = mkdtempSync(resolve(root, 'build/qa09-a1-test-'));
  const write = (name, value) => {
    const path = relative(root, resolve(directory, name));
    writeFileSync(resolve(root, path), JSON.stringify(value));
    return bindFile(root, path);
  };
  return Promise.resolve()
    .then(() => action(write))
    .finally(() => rmSync(directory, { recursive: true, force: true }));
}
function completeProcessingReceipt(c) {
  const passed = { passed: true, evidence: ['unit-test-only:not-a-target-receipt'] };
  const probes = Object.fromEntries(
    Object.entries(REQUIRED_PROBES).map(([group, names]) => [
      group,
      Object.fromEntries(names.map((name) => [name, { ...passed }])),
    ]),
  );
  Object.assign(probes.archive.s3Object, { sha256: 'a'.repeat(64) });
  Object.assign(probes.archive.manifest, { sha256: 'a'.repeat(64) });
  Object.assign(probes.archive.duplicateDelivery, { deliveryCount: 2, logicalRecordCount: 1 });
  Object.assign(probes.archive.partialFailure, { failedCount: 1, succeededCount: 1 });
  probes.replay.idempotency.duplicateBusinessRows = 0;
  for (const key of ['hourly', 'daily', 'esgDaily']) probes.summary[key].rowCount = 1;
  const { mode, isolated, accountId, region, stackName } = c.environment;
  return {
    schemaVersion: '1.0',
    status: 'PASS',
    sourceCommit: c.versions.application.sourceCommit,
    executedAt: '2026-10-13T04:06:14.951Z',
    environment: { mode, isolated, accountId, region, stackName, runPrefix: 'qa09-137cca6c85a85599' },
    probes,
    cleanup: { ...passed, completed: true },
  };
}
test('A1 binds three different versions and retains recorded deployment/artifact/config proof', () => {
  const c = context();
  validateTargetBindings(root, c);
  assert.notEqual(c.versions.application.sourceCommit, c.versions.executor.baseCommit);
  assert.equal(c.versions.executor.kind, 'CONTENT_SNAPSHOT');
  assert.equal(c.versions.documentation.kind, 'CONTENT_SNAPSHOT');
  assert.equal(c.versions.application.freshness, 'RECORDED_TARGET_SNAPSHOT_NOT_A_NEW_LIVE_READ');
});
test('wrong app/deploy/environment, incomplete executor/doc versions and content drift fail closed', () => {
  for (const mutate of [
    (c) => {
      c.versions.application.sourceCommit = 'a'.repeat(40);
    },
    (c) => {
      c.versions.application.deploymentCommit = 'b'.repeat(40);
    },
    (c) => {
      c.environment.accountId = '000000000000';
    },
    (c) => {
      c.environment.isolated = true;
    },
    (c) => {
      c.environment.syntheticResponsesAllowed = true;
    },
    (c) => {
      c.versions.executor.files.pop();
    },
    (c) => {
      c.versions.executor.files[0].sha256 = 'a'.repeat(64);
    },
    (c) => {
      c.versions.documentation.snapshotSha256 = 'a'.repeat(64);
    },
    (c) => {
      c.requiredDocumentation.pop();
    },
    (c) => {
      c.fullQa09Accepted = true;
    },
  ]) {
    const c = context();
    mutate(c);
    assert.throws(() => validateTargetBindings(root, c));
  }
});
test('existing environment never falls back to an isolated claim or accepts absent provenance', () => {
  const c = context(),
    r = completeProcessingReceipt(c);
  assert.deepEqual(targetEnvironmentErrors(r.environment, c), []);
  assert.ok(targetEnvironmentErrors(r.environment).length);
  r.environment.isolated = true;
  assert.ok(targetEnvironmentErrors(r.environment, c).length);
  assert.throws(() => readBoundFile(root, { path: '../outside', sha256: 'a'.repeat(64) }));
});
test('formal check accepts matching app/ledger/cleanup independently of HEAD, rejects cross-prefix/hash/source', async () =>
  fixture((write) => {
    const c = context(),
      receipt = completeProcessingReceipt(c),
      dir = 'docs/audit/evidence/qa-09-close-07-esg-2026-10-13/';
    const ref = write('receipt.json', receipt);
    const row = {
      validator: 'check-aws-data-processing-evidence.mjs',
      receipt: ref,
      createdIdLedger: bindFile(root, dir + 'target-v3.json'),
      cleanupReceipt: bindFile(root, dir + 'final-readonly.json'),
    };
    c.formalReceipts = [row];
    assert.deepEqual(checkAwsDataProcessingEvidence(root, ref.path, c.versions.application.sourceCommit, c), []);
    const badLedger = JSON.parse(readFileSync(resolve(root, row.createdIdLedger.path)));
    badLedger.prefix = 'qa09-0000000000000000';
    row.createdIdLedger = write('foreign-ledger.json', badLedger);
    assert.ok(validateReceiptBinding(root, ref.path, receipt, c, row.validator).some((e) => e.includes('OWNERSHIP')));
    row.createdIdLedger = bindFile(root, dir + 'target-v3.json');
    row.cleanupReceipt.sha256 = 'a'.repeat(64);
    assert.ok(validateReceiptBinding(root, ref.path, receipt, c, row.validator).some((e) => e.includes('DRIFT')));
    row.cleanupReceipt = bindFile(root, dir + 'final-readonly.json');
    const incompleteCleanup = JSON.parse(readFileSync(resolve(root, row.cleanupReceipt.path)));
    incompleteCleanup.archives[0].versions = 1;
    row.cleanupReceipt = write('nonempty-cleanup.json', incompleteCleanup);
    assert.ok(
      validateReceiptBinding(root, ref.path, receipt, c, row.validator).some((e) => e.includes('CLEANUP_CONTENT')),
    );
    row.cleanupReceipt = bindFile(root, dir + 'final-readonly.json');
    receipt.sourceCommit = 'a'.repeat(40);
    row.receipt = write('wrong-app.json', receipt);
    assert.ok(checkAwsDataProcessingEvidence(root, row.receipt.path, c.versions.application.sourceCommit, c).length);
  }));
test('entry rebuilds the exact frozen obligations and never promotes four scoped proofs to eight formal receipts', async () => {
  const result = await checkAcceptanceEntry(root, context());
  assert.equal(result.gate, 'PASS_A1_ENTRY_AND_FROZEN_INVENTORY');
  assert.equal(result.formalPassCount, 0);
  assert.equal(result.formalDomains.length, 8);
  assert.equal(result.mandatorySupplemental.length, 23);
  assert.equal(result.releaseDeferrals.length, 5);
  const c = context();
  const scope = JSON.parse(readBoundFile(root, c.frozenScope));
  const inventory = JSON.parse(readBoundFile(root, c.inventory));
  assert.equal(scope.prototype.requiredElements.length, 117);
  assert.equal(scope.prototype.forbiddenOrReadonly.length, 11);
  assert.equal(inventory.operationRoleLedger.length, 112);
  assert.equal(inventory.prototypeLedger.length, 117);
  assert.equal(inventory.deduplicatedNeverRunGaps.length, 32);
  assert.ok(inventory.evidence.every((item) => item.sourceEquivalent && item.configEquivalent));
  assert.equal(result.qa09BusinessGate, 'PARTIAL');
  assert.equal(result.fullQa09Accepted, false);
});
test('rehashed scope deletions, security deferrals and unsupported inventory PASS are rejected', async () =>
  fixture(async (write) => {
    for (const mutate of [
      (scope) => {
        scope.mandatorySupplemental.pop();
      },
      (scope) => {
        scope.releaseDeferrals.push({ id: 'security', status: 'DEFERRED' });
      },
      (scope) => {
        scope.domains[0].requiredSets.UPLINK_TYPES.pop();
      },
    ]) {
      const c = context(),
        scope = JSON.parse(readBoundFile(root, c.frozenScope));
      mutate(scope);
      c.frozenScope = write('bad-scope.json', scope);
      await assert.rejects(checkAcceptanceEntry(root, c), /FROZEN_REQUIRED_SCOPE_DRIFT/);
    }
    const c = context(),
      inventory = JSON.parse(readBoundFile(root, c.inventory));
    inventory.mandatory[0].status = 'PASS';
    c.inventory = write('fake-pass.json', inventory);
    await assert.rejects(checkAcceptanceEntry(root, c), /PROMOTION_OR_SCOPE_DRIFT/);
  }));
test('CLI default remains nonzero while explicit A1-only readiness succeeds with QA09 partial', async () =>
  fixture((write) => {
    const currentContext = write('current-entry-context.json', context());
    for (const entryOnly of [false, true]) {
      const run = spawnSync(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/check-qa09-acceptance.mjs',
          currentContext.path,
          ...(entryOnly ? ['--entry-only'] : []),
        ],
        { cwd: root, encoding: 'utf8', timeout: 30000 },
      );
      assert.equal(run.status, entryOnly ? 0 : 1, run.stderr);
      assert.equal(JSON.parse(run.stdout).qa09BusinessGate, 'PARTIAL');
      assert.equal(JSON.parse(run.stdout).fullQa09Accepted, false);
    }
  }));
