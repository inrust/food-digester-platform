import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertOwnedIdentity, assertOwnedRecord } from './run-qa09-real-business-smoke.mjs';
const roles = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
export function validateSmoke(receipt, archive) {
  if (
    receipt.gate !== 'PASS' ||
    receipt.scope !== 'FIVE_ROLE_SRP_AND_CUSTOMER_SITE_SMOKE' ||
    receipt.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !Number.isFinite(Date.parse(receipt.finishedAt)) ||
    Date.parse(receipt.finishedAt) < Date.parse(receipt.startedAt) ||
    receipt.target?.accountId !== '065986019555' ||
    receipt.target?.stackName !== 'fdp-test-app' ||
    receipt.target?.region !== 'ap-southeast-1' ||
    receipt.target?.syntheticResponsesAllowed !== false
  )
    throw Error('INCOMPLETE_OR_WRONG_TARGET');
  if (receipt.checks?.some((c) => c.result !== 'PASS') || !receipt.checks?.length)
    throw Error('FAILED_OR_MISSING_CHECKS');
  const required = roles.flatMap((r) =>
    ['first-login-challenge', 'srp-login', 'role-scope', 'refresh', 'wrong-password', 'site-read-own'].map(
      (s) => r + ':' + s,
    ),
  );
  required.push(
    'customer-create-a',
    'customer-create-b',
    'site-create-0',
    'site-create-1',
    'CustomerAdmin:cross-customer-denied',
    'CustomerViewer:cross-customer-denied',
    'Auditor:site-write-denied',
    'CustomerAdmin:site-write-denied',
    'CustomerViewer:site-write-denied',
    'PlatformSuperAdmin:users-read',
    'Auditor:users-read',
    'PlatformOperator:users-read-denied',
    'customer-update',
    'customer-stale-version',
  );
  if (required.some((id) => receipt.checks.filter((c) => c.id === id).length !== 1))
    throw Error('REQUIRED_PROBE_MISSING');
  if (
    receipt.createdIdentities?.length !== 5 ||
    new Set(receipt.createdIdentities.map((i) => i.role)).size !== 5 ||
    receipt.createdRecords?.length !== 4
  )
    throw Error('FIXTURE_INCOMPLETE');
  for (const identity of receipt.createdIdentities) {
    assertOwnedIdentity(identity.username, receipt.prefix);
    if (
      !receipt.cleanup.some(
        (c) => c.type === 'cognito-user' && c.username === identity.username && c.status === 'DELETED',
      )
    )
      throw Error('IDENTITY_CLEANUP_MISSING');
  }
  for (const record of receipt.createdRecords) {
    assertOwnedRecord(record, receipt.prefix);
    if (
      !receipt.cleanup.some(
        (c) => c.type === record.type && c.id === record.id && c.status === 'SOFT_DELETED_AND_NOT_VISIBLE',
      )
    )
      throw Error('RECORD_CLEANUP_MISSING');
    for (const phase of ['read', 'delete', 'verify'])
      if (!receipt.checks.some((c) => c.id === `cleanup-${phase}-${record.type}-${record.id}` && c.result === 'PASS'))
        throw Error('CLEANUP_PROBE_MISSING');
  }
  if (receipt.cleanup.some((c) => c.status === 'FAILED')) throw Error('CLEANUP_FAILED');
  if (archive.sourceCommit !== receipt.sourceCommit) throw Error('ARCHIVE_VERSION_MISMATCH');
  if (Object.keys(receipt.sourceHashes ?? {}).length !== 5) throw Error('SOURCE_BINDINGS_MISSING');
  for (const [p, h] of Object.entries(receipt.sourceHashes)) {
    const source = archive.sources?.[p];
    if (
      !source ||
      source.sha256 !== h ||
      createHash('sha256').update(Buffer.from(source.base64, 'base64')).digest('hex') !== h
    )
      throw Error('EXECUTED_SOURCE_MISMATCH');
  }
  const serialized = JSON.stringify(receipt);
  if (/"(?:accessToken|idToken|refreshToken|password|SecretString|privateKey)"\s*:/.test(serialized))
    throw Error('SENSITIVE_RECEIPT');
  return { scope: receipt.scope, gate: 'PASS', checks: receipt.checks.length, fullQa09Accepted: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  try {
    console.log(
      JSON.stringify(
        validateSmoke(
          JSON.parse(readFileSync(process.argv[2], 'utf8')),
          JSON.parse(readFileSync(process.argv[3], 'utf8')),
        ),
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
