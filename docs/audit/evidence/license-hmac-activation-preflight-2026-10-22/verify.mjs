/** Offline reconciliation: passing this script preserves the BLOCKED target result. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const directory = fileURLToPath(new URL('.', import.meta.url));
const repository = resolve(directory, '../../../..');
const read = (name) => readFileSync(resolve(directory, name));
const json = (name) => JSON.parse(read(name));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const summary = json('summary.json');
assert.equal(summary.gate, 'BLOCKED_EXTERNAL_OPERATIONS_AUTHORITY');
assert.equal(summary.userConfirmation.answer, '运营没有提供');
assert.deepEqual(summary.resourcesCreated, []);
assert.deepEqual(summary.resourcesModified, []);
assert.equal(summary.secretValueRead, false);
assert.equal(summary.iamOrKmsChanged, false);
assert.equal(summary.targetResults.independentHmac, 'NOT_RUN');
assert.equal(summary.targetResults.verifiedToActive, 'NOT_RUN');
assert.equal(summary.targetResults.cloudBusinessReadback, 'NOT_RUN_NO_DEVICE_CREATED');
assert.equal(summary.targetResults.cleanup, 'NOT_REQUIRED_NO_RESOURCES_CREATED');
assert.equal(summary.sourcePackage.status, 'PREPARED_NOT_DEPLOYED');
assert.equal(summary.sourcePackage.runtimeInvocation, 'NOT_RUN');
assert.equal(summary.sourcePackage.sdkDependenciesIncluded, false);
const account = json('account.json');
assert.equal(account.exitCode, 0);
assert.equal(JSON.parse(account.stdout).Account, '065986019555');
const role = json('dedicated-role.json');
assert.equal(role.exitCode, 254);
assert.match(role.stderr, /NoSuchEntity/);
assert.match(role.stderr, /fdp-test-qa09-license-verifier-role cannot be found/);
const inventory = json('lambda-inventory.json');
assert.equal(inventory.exitCode, 0);
const names = JSON.parse(inventory.stdout);
assert.equal(names.length, 19);
assert.equal(new Set(names).size, 19);
assert(names.every((name) => name.startsWith('fdp-test-')));
assert(!names.some((name) => /verifier/i.test(name)));
for (const name of ['account', 'dedicated-role', 'lambda-inventory', 'profiles']) {
  const receipt = json(name + '.json');
  assert.equal(receipt.readOnly, true);
  assert(!receipt.command.includes('get-secret-value'));
}
for (const name of readdirSync(directory).filter((name) => name.endsWith('.json') && name !== 'verification.json')) {
  const receipt = json(name);
  if (receipt.outputSha256) assert.equal(sha(Buffer.from(receipt.stdout)), receipt.outputSha256, name);
}
const scripts = json('all-script-tests-attempt-2-pass.json');
assert.equal(scripts.exitCode, 0);
assert.match(scripts.stdout, /tests 1459/);
assert.match(scripts.stdout, /pass 1459/);
assert.match(scripts.stdout, /fail 0/);
const first = json('all-script-tests-attempt-1-fail.json');
assert.equal(first.exitCode, 1);
assert.match(first.stdout, /listen EPERM/);
assert.match(first.stdout, /fail 3/);
assert.match(json('local-tests-attempt-1-fail.json').stdout, /ERR_MODULE_NOT_FOUND/);
assert.match(json('local-tests-attempt-2-pass.json').stdout, /pass 9/);
assert.match(json('local-license-sync-tests.json').stdout, /10 passed/);
const checks = json('final-checks.json');
assert.equal(checks.localGate, 'PASS_LOCAL_ONLY');
assert.equal(checks.targetGate, summary.gate);
assert.equal(checks.links.missing.length, 0);
for (const check of checks.commands) assert.equal(check.exitCode, 0, check.command.join(' '));
const manifest = json('manifest.json');
const actual = readdirSync(directory)
  .filter((name) => !['manifest.json', 'verification.json'].includes(name))
  .sort();
assert.deepEqual(Object.keys(manifest.files).sort(), actual);
for (const name of actual) assert.equal(sha(read(name)), manifest.files[name], name);
if (process.argv.includes('--current-source')) {
  for (const [name, expected] of Object.entries(summary.sourceSha256))
    assert.equal(sha(readFileSync(resolve(repository, name))), expected, name);
}
process.stdout.write(
  JSON.stringify({
    gate: 'PASS_RECONCILED_BLOCKED',
    targetGate: summary.gate,
    independentHmac: 'NOT_RUN',
    verifiedToActive: 'NOT_RUN',
    cleanup: summary.targetResults.cleanup,
    evidenceFiles: actual.length,
    currentSourceChecked: process.argv.includes('--current-source'),
  }) + '\n',
);
