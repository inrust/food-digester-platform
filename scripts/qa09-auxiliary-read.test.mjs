import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = dirname(fileURLToPath(import.meta.url));
const collector = join(scripts, 'collect-qa09-auxiliary-phases.py');
const driver = join(scripts, 'qa09_auxiliary_read_test_driver.py');
const common = [
  'complete',
  'gateway-string',
  'gateway-whitespace',
  'gateway-exponent',
  'gateway-fraction-string',
  'gateway-leading-zero',
  'gateway-unsafe-string',
  'gateway-bool',
  'gateway-number-fraction',
  'gateway-null',
  'gateway-empty',
  'gateway-unicode',
  'gateway-malformed',
  'gateway-negative',
  'gateway-string-outside',
  'timeout',
  'report-timeout',
  'deadline',
  'denied',
  'expired',
  'throttled',
  'unknown',
  'unavailable',
  'malformed',
  'repeat',
  'page-limit',
  'call-limit',
  'duplicate-gateway',
  'invalid-invocation',
  'invocation-reuse',
  'nested-field',
  'gateway-lambda',
  'duplicate-completion',
  'missing-report',
  'duplicate-report',
  'report-invalid-number',
  'source-drift',
  'output-exists',
];
for (const mode of ['initial', 'negative']) {
  const extra =
    mode === 'initial'
      ? ['short-initial', 'parent-drift', 'invalid-prefix']
      : [
          'rejected',
          'gateway-rejected-string',
          'rejected-leak',
          'gateway-time',
          'gateway-status',
          'extended-id',
          'duplicate-id',
          'latency-invalid',
          'time-invalid',
        ];
  for (const scenario of [...common, ...extra]) {
    test(`bounded auxiliary ${mode}: ${scenario}`, () => {
      const result = spawnSync('python3', [driver, mode, scenario], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 0, result.stderr);
      const proof = JSON.parse(result.stdout);
      assert.equal(proof.gate, 'PASS');
      assert.equal(proof.awsCalls, 0);
      assert.ok(proof.cliCalls <= 40);
      if (process.env.QA09_AUX_READ_EVIDENCE_DIR) {
        writeFileSync(
          join(resolve(process.env.QA09_AUX_READ_EVIDENCE_DIR), `${mode}-${scenario}.json`),
          `${JSON.stringify(proof, null, 2)}\n`,
          { flag: 'wx' },
        );
      }
    });
  }
}

test('auxiliary real CLI imports the sibling reader from an unrelated cwd in isolated Python', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qa09-auxiliary-import-'));
  try {
    writeFileSync(join(folder, 'qa09_log_read.py'), 'raise RuntimeError("foreign module")\n');
    const result = spawnSync('python3', ['-I', collector, '--check-import'], {
      cwd: folder,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PYTHONPATH: folder },
    });
    assert.equal(result.status, 0, result.stderr);
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.modulePath, join(scripts, 'qa09_log_read.py'));
    assert.equal(proof.readerSha256, createHash('sha256').update(readFileSync(proof.modulePath)).digest('hex'));
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('auxiliary actual CLI preserves a safe failure and refuses to reread an existing output', () => {
  const folder = mkdtempSync(join(tmpdir(), 'qa09-auxiliary-cli-'));
  try {
    const bin = join(folder, 'bin');
    mkdirSync(bin);
    const marker = join(folder, 'calls');
    writeFileSync(
      join(bin, 'aws'),
      `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'call\\n');console.error('AccessDenied PRIVATE_AUX_SENTINEL');process.exit(1);\n`,
      { mode: 0o700 },
    );
    const sha = 'a'.repeat(40);
    const parent = {
      gate: 'PASS',
      sourceCommit: sha,
      prefix: 'qa09-1234567890abcdef',
      startedAt: '2026-10-12T00:00:00Z',
      finishedAt: '2026-10-12T00:00:01Z',
      checks: Array.from({ length: 8 }, (_, i) => ({
        requestId: `20000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      })),
    };
    const child = join(folder, 'child.json');
    const source = join(folder, 'parent.json');
    const output = join(folder, 'output.json');
    writeFileSync(source, JSON.stringify(parent));
    writeFileSync(child, JSON.stringify({ ...parent, checks: [] }));
    const args = ['-I', collector, child, output, '--mode', 'initial', '--expected-commit', sha, '--parent', source];
    const options = {
      cwd: folder,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    };
    const first = spawnSync('python3', args, options);
    assert.equal(first.status, 1, first.stderr);
    const receipt = readFileSync(output, 'utf8');
    assert.equal(JSON.parse(receipt).collectionError, 'LOG_ACCESS_DENIED');
    assert.ok(!receipt.includes('PRIVATE_AUX_SENTINEL'));
    const second = spawnSync('python3', args, options);
    assert.equal(second.status, 1);
    assert.equal(JSON.parse(second.stdout).error, 'AUX_OUTPUT_EXISTS');
    assert.equal(readFileSync(output, 'utf8'), receipt);
    assert.equal(readFileSync(marker, 'utf8'), 'call\n');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
