import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertOwnUnseededIdentity, assertOwnIdentityMetadata } from './qa09-owned-identity-scope.mjs';
const [parentFile, output] = process.argv.slice(2),
  bytes = readFileSync(parentFile),
  parent = JSON.parse(bytes);
const username = assertOwnUnseededIdentity(parent);
const sha = (v) => createHash('sha256').update(v).digest('hex'),
  source = readFileSync(new URL(import.meta.url));
const r = {
  task: 'QA-09',
  scope: 'OWN_UNSEEDED_IDENTITY_CLEANUP',
  prefix: parent.prefix,
  username,
  parentReceipt: parentFile,
  parentReceiptSha256: sha(bytes),
  sourceHash: sha(source),
  sourceBase64: source.toString('base64'),
  identityScopeSourceSha256: sha(readFileSync(new URL('./qa09-owned-identity-scope.mjs', import.meta.url))),
  startedAt: new Date().toISOString(),
  gate: 'RUNNING',
  credentialsExported: false,
  passwordChanged: false,
};
const aws = (args) => {
  const out = spawnSync(
    'aws',
    [
      ...args,
      '--profile',
      'esgiot-infra',
      '--region',
      'ap-southeast-1',
      '--output',
      'json',
      '--no-cli-pager',
      '--cli-connect-timeout',
      '5',
      '--cli-read-timeout',
      '10',
    ],
    { encoding: 'utf8', timeout: 30000 },
  );
  if (out.status !== 0)
    throw Object.assign(Error('IDENTITY_AWS_OPERATION_FAILED'), {
      code: out.stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? 'CLI_FAILED',
    });
  return out.stdout.trim() ? JSON.parse(out.stdout) : null;
};
const pool = 'ap-southeast-1_hZMX8LpFo';
try {
  if (aws(['sts', 'get-caller-identity']).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
  const found = aws(['cognito-idp', 'admin-get-user', '--user-pool-id', pool, '--username', username]);
  assertOwnIdentityMetadata(parent, found);
  r.createdAt = found.UserCreateDate;
  aws(['cognito-idp', 'admin-delete-user', '--user-pool-id', pool, '--username', username]);
  let absent = false;
  try {
    aws(['cognito-idp', 'admin-get-user', '--user-pool-id', pool, '--username', username]);
  } catch (e) {
    absent = e.code === 'UserNotFoundException';
  }
  if (!absent) throw Error('IDENTITY_ABSENCE_NOT_PROVED');
  r.gate = 'PASS';
  r.absenceErrorCode = 'UserNotFoundException';
} catch (e) {
  r.gate = 'FAIL';
  r.errorCode = e.code ?? e.message;
}
r.finishedAt = new Date().toISOString();
writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
console.log(JSON.stringify({ gate: r.gate, prefix: r.prefix, errorCode: r.errorCode }));
process.exitCode = r.gate === 'PASS' ? 0 : 1;
