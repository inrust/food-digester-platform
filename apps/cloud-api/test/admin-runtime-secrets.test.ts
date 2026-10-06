import { rejects } from 'node:assert/strict';
import { assert, test, vi } from 'vitest';
import { withDataPathTrace } from '@fdp/observability';
import { readAdminRuntimeConfig, resolveAdminRuntimeSecrets } from '../src/runtime/admin-runtime-secrets.js';
const environment = {
  AWS_REGION: 'ap-southeast-1',
  DB_SECRET_ARN: 'db-reference',
  LICENSE_SIGNING_KEY_SECRET_ARN: 'license-reference',
  EXPORT_BUCKET_NAME: 'export',
  OTA_BUCKET_NAME: 'ota',
  MEDIA_BUCKET_NAME: 'media',
  OTA_SIGNING_KEY_ARN: 'signing-reference',
  USER_POOL_ID: 'pool',
  USER_POOL_CLIENT_ID: 'client',
  FDP_DB_POOL_MAX: '1',
};
const deferred = () => {
  let resolve!: (value: string) => void, reject!: (error: unknown) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
test('all required config and feature/pool settings validate before resolving remote secrets', () => {
  for (const key of Object.keys(environment).filter((k) => k !== 'FDP_DB_POOL_MAX'))
    assert.throws(() => readAdminRuntimeConfig({ ...environment, [key]: '' }));
  assert.throws(() => readAdminRuntimeConfig({ ...environment, FDP_DB_POOL_MAX: '20' }));
  assert.throws(() => readAdminRuntimeConfig({ ...environment, FDP_ADMIN_PARALLEL_SECRETS: 'yes' }));
  assert.isTrue(readAdminRuntimeConfig(environment).parallelSecrets);
  assert.isFalse(readAdminRuntimeConfig({ ...environment, FDP_ADMIN_PARALLEL_SECRETS: 'false' }).parallelSecrets);
});
test('both remote calls overlap, retain exact references, complete before use and record no secret values', async () => {
  const db = deferred(),
    key = deferred(),
    rows: Record<string, unknown>[] = [];
  const database = vi.fn(() => db.promise),
    license = vi.fn(() => key.promise);
  let completed = false;
  const result = withDataPathTrace(
    {},
    () =>
      resolveAdminRuntimeSecrets(readAdminRuntimeConfig(environment), { database, license }).then((value) => {
        completed = true;
        return value;
      }),
    (r) => rows.push(r),
  );
  assert.equal(database.mock.calls.length, 1);
  assert.equal(license.mock.calls.length, 1);
  assert.deepEqual(database.mock.calls[0], [{ secretArn: environment.DB_SECRET_ARN, region: environment.AWS_REGION }]);
  assert.deepEqual(license.mock.calls[0], [
    { secretArn: environment.LICENSE_SIGNING_KEY_SECRET_ARN, region: environment.AWS_REGION },
  ]);
  db.resolve('private-db-value');
  await Promise.resolve();
  assert.isFalse(completed);
  key.resolve('private-license-value');
  assert.deepEqual(await result, { databaseUrl: 'private-db-value', licenseSigningKey: 'private-license-value' });
  assert.deepEqual(
    rows.map((r) => r.phase),
    ['runtime-database-secret', 'runtime-license-secret'],
  );
  assert.notInclude(JSON.stringify(rows), 'private-');
});
test('parallel failure waits for sibling, chooses original DB-first failure and has no retry/unhandled rejection', async () => {
  const db = deferred(),
    key = deferred(),
    dbError = Error('db private details'),
    keyError = Error('key private details');
  const database = vi.fn(() => db.promise),
    license = vi.fn(() => key.promise);
  let settled = false;
  const work = resolveAdminRuntimeSecrets(readAdminRuntimeConfig(environment), { database, license });
  const proof = rejects(
    work.finally(() => {
      settled = true;
    }),
    (error) => error === dbError,
  );
  key.reject(keyError);
  await Promise.resolve();
  assert.isFalse(settled);
  db.reject(dbError);
  await proof;
  assert.equal(database.mock.calls.length, 1);
  assert.equal(license.mock.calls.length, 1);
  const otherError = Error('original licensing failure');
  await rejects(
    resolveAdminRuntimeSecrets(readAdminRuntimeConfig(environment), {
      database: async () => 'db',
      license: async () => {
        throw otherError;
      },
    }),
    (error) => error === otherError,
  );
  await rejects(
    resolveAdminRuntimeSecrets(readAdminRuntimeConfig(environment), {
      database: () => {
        throw dbError;
      },
      license: async () => 'key',
    }),
    (error) => error === dbError,
  );
});
test('sequential rollback preserves ordering and skips second secret after first failure', async () => {
  const config = readAdminRuntimeConfig({ ...environment, FDP_ADMIN_PARALLEL_SECRETS: 'false' }),
    db = deferred(),
    license = vi.fn(async () => 'key');
  const work = resolveAdminRuntimeSecrets(config, { database: () => db.promise, license });
  assert.equal(license.mock.calls.length, 0);
  db.resolve('db');
  assert.deepEqual(await work, { databaseUrl: 'db', licenseSigningKey: 'key' });
  license.mockClear();
  const error = Error('db');
  await rejects(
    resolveAdminRuntimeSecrets(config, {
      database: async () => {
        throw error;
      },
      license,
    }),
    (e) => e === error,
  );
  assert.equal(license.mock.calls.length, 0);
});
