import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkAuxiliaryRead } from './check-qa09-auxiliary-read.mjs';

const scripts = dirname(fileURLToPath(import.meta.url));
function fixture(mode, scenario, run) {
  const result = spawnSync('python3', [join(scripts, 'qa09_auxiliary_read_test_driver.py'), mode, scenario], {
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout);
  const dir = mkdtempSync(join(tmpdir(), 'qa09-aux-proof-'));
  const paths = ['child.json', 'aux.json', 'parent.json'].map((name) => join(dir, name));
  try {
    writeFileSync(paths[0], proof.inputBytes.child);
    writeFileSync(paths[2], proof.inputBytes.parent);
    run(proof.result, paths);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
for (const [mode, scenario] of [
  ['initial', 'complete'],
  ['negative', 'complete'],
  ['negative', 'rejected'],
  ['initial', 'gateway-string'],
  ['negative', 'gateway-string'],
  ['negative', 'gateway-rejected-string'],
]) {
  test(`auxiliary budget proof accepts ${mode}/${scenario}`, () =>
    fixture(mode, scenario, (receipt, paths) => {
      writeFileSync(paths[1], JSON.stringify(receipt));
      const result = checkAuxiliaryRead(paths[0], paths[1], mode === 'initial' ? paths[2] : undefined);
      assert.equal(result.gate, 'PASS');
      assert.equal(
        result.calls,
        ['rejected', 'gateway-rejected-string'].includes(scenario) ? 16 : mode === 'initial' ? 18 : 24,
      );
      assert.equal(result.p95Accepted, false);
    }));
}

const corruptions = {
  'completion event': (r) => {
    r.records[0].completion[0].event = 'data-path.phase.completed';
  },
  'phase event': (r) => {
    r.records[0].phases[0].event = 'admin.request.completed';
  },
  'reader bytes': (r) => {
    r.readerSha256 = '0'.repeat(64);
  },
  'collector bytes': (r) => {
    r.bindings.collectorSha256 = '0'.repeat(64);
  },
  'child bytes': (r) => {
    r.bindings.childSha256 = '0'.repeat(64);
  },
  'parent bytes': (r) => {
    r.bindings.parentSha256 = '0'.repeat(64);
  },
  'foreign batch': (r) => {
    r.readBatches[0].members[0] = 'f'.repeat(36);
  },
  'oversized batch': (r) => {
    r.readBatches[0].members.push(r.requestIds[3]);
  },
  'unowned call': (r) => {
    r.logReadBudget.attempts.push({ ...r.logReadBudget.attempts[0], query: 99 });
  },
  'missing page': (r) => {
    r.logReadBudget.attempts[0].page = 2;
  },
  'failed page': (r) => {
    r.logReadBudget.attempts[0].result = 'FAIL';
  },
  'changed budget': (r) => {
    r.logReadBudget.maxCalls = 48;
  },
  'late receipt': (r) => {
    r.logReadBudget.elapsedMs = 120000;
  },
  'partial reader': (r) => {
    r.logReadBudget.error = 'LOG_CALL_LIMIT';
  },
  'pending rows': (r) => {
    r.pendingRecords = [{}];
  },
  'missing record': (r) => {
    r.records.pop();
  },
  'duplicate record': (r) => {
    r.records[1] = r.records[0];
  },
  'payload field': (r) => {
    r.records[0].completion[0].password = 'PRIVATE_SENTINEL';
  },
  'nested field': (r) => {
    r.records[0].completion[0].elapsedMs = { password: 'PRIVATE_SENTINEL' };
  },
  'report identity': (r) => {
    r.records[0].platformReports[0].lambdaRequestId = r.records[1].lambdaRequestId;
  },
  'gateway time': (r) => {
    r.records[0].gateway[0].requestTimeEpoch = 0;
  },
};
for (const [name, corrupt] of Object.entries(corruptions)) {
  test(`auxiliary budget proof rejects ${name}`, () =>
    fixture('initial', 'complete', (receipt, paths) => {
      corrupt(receipt);
      writeFileSync(paths[1], JSON.stringify(receipt));
      assert.throws(() => checkAuxiliaryRead(...paths));
    }));
}
for (const scenario of ['call-limit', 'timeout', 'report-timeout']) {
  test(`auxiliary budget proof rejects preserved ${scenario} partial`, () =>
    fixture('initial', scenario, (receipt, paths) => {
      writeFileSync(paths[1], JSON.stringify(receipt));
      assert.throws(() => checkAuxiliaryRead(...paths));
    }));
}

for (const value of [
  ' 1791763200000',
  '1791763200000 ',
  '1e12',
  '1791763200000.0',
  '01791763200000',
  '9007199254740992',
  '',
  '１２３',
  'NaN',
  true,
  null,
  1.5,
  -1,
  9007199254740992,
]) {
  test(`auxiliary checker rejects invalid Gateway epoch ${JSON.stringify(value)}`, () =>
    fixture('negative', 'rejected', (receipt, paths) => {
      receipt.records[0].gateway[0].requestTimeEpoch = value;
      writeFileSync(paths[1], JSON.stringify(receipt));
      assert.throws(() => checkAuxiliaryRead(paths[0], paths[1]), /AUX_GATEWAY_TIME_INVALID/);
    }));
}
