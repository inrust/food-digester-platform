/** Read-only independent confirmation after the isolated run has completed cleanup. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import console from 'node:console';
import process from 'node:process';
const exec = promisify(execFile);
const dir = fileURLToPath(new URL('.', import.meta.url));
const r = JSON.parse(readFileSync(dir + 'attempt-1/receipt.json'));
if (
  r.gate !== 'PASS' ||
  !r.cleanup.every((c) => c.result === 'PASS') ||
  !/^syncprobe-[a-f0-9]{16}$/.test(r.scope.serial)
)
  throw Error('COMPLETED_OWN_TEST_REQUIRED');
async function aws(args) {
  return exec('aws', [...args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1', '--output', 'json'], {
    timeout: 45000,
    maxBuffer: 1048576,
  });
}
if (JSON.parse((await aws(['sts', 'get-caller-identity'])).stdout).Account !== '065986019555')
  throw Error('WRONG_ACCOUNT');
const jobs = [
  ['thing', ['iot', 'describe-thing', '--thing-name', r.deviceId], 'ResourceNotFoundException'],
  [
    'observer',
    ['lambda', 'get-function-configuration', '--function-name', 'fdp-test-qa09-' + r.scope.serial],
    'ResourceNotFoundException',
  ],
  [
    'cognito',
    ['cognito-idp', 'admin-get-user', '--user-pool-id', 'ap-southeast-1_hZMX8LpFo', '--username', r.scope.username],
    'UserNotFoundException',
  ],
  ...r.certificates.map((c) => [
    'certificate:' + c.id,
    ['iot', 'describe-certificate', '--certificate-id', c.id],
    'ResourceNotFoundException',
  ]),
  ...r.cleanup
    .find((c) => c.label === 'owned-iot-and-database')
    .detail.policyNames.map((p) => [
      'policy:' + p,
      ['iot', 'get-policy', '--policy-name', p],
      'ResourceNotFoundException',
    ]),
];
const absent = await Promise.all(
  jobs.map(async ([label, args, code]) => {
    try {
      await aws(args);
      return { label, result: 'FAIL', reason: 'RESOURCE_PRESENT' };
    } catch (e) {
      return {
        label,
        result: e.stderr?.includes(code) ? 'PASS' : 'FAIL',
        code: e.stderr?.match(/\(([A-Za-z0-9]+)\)/)?.[1] ?? 'UNKNOWN',
      };
    }
  }),
);
const archives = await Promise.all(
  r.customers.map(async (c) => {
    const prefix = 'domain/entity_type=license/customer_id=' + c.id + '/';
    const v = JSON.parse(
      (
        await aws([
          's3api',
          'list-object-versions',
          '--bucket',
          'fdp-test-raw-065986019555',
          '--prefix',
          prefix,
          '--max-keys',
          '100',
          '--no-paginate',
        ])
      ).stdout,
    );
    return {
      prefix,
      result: !v.IsTruncated && !(v.Versions ?? []).length && !(v.DeleteMarkers ?? []).length ? 'PASS' : 'FAIL',
      versions: v.Versions?.length ?? 0,
      deleteMarkers: v.DeleteMarkers?.length ?? 0,
    };
  }),
);
const result = {
  at: new Date().toISOString(),
  deviceId: r.deviceId,
  scope: r.scope.serial,
  checks: [...absent, ...archives],
  retained: ['CloudWatch logs', 'audit rows', 'disabled admin row', 'soft-deleted Customer/Site tombstones'],
};
result.gate = result.checks.every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL';
writeFileSync(dir + 'cleanup-readback.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ gate: result.gate, checks: result.checks.length }));
if (result.gate !== 'PASS') process.exitCode = 1;
