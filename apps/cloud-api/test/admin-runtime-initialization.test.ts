import { assert, test, vi, afterEach } from 'vitest';
const mocks = vi.hoisted(() => ({ database: vi.fn(), license: vi.fn(), client: vi.fn() }));
vi.mock('@fdp/aws-clients', async (importActual) => ({
  ...(await importActual<object>()),
  resolveDatabaseUrl: mocks.database,
  resolveSecretString: mocks.license,
}));
vi.mock('@fdp/database', async (importActual) => {
  const actual = await importActual<typeof import('@fdp/database')>();
  return { ...actual, createPrismaClient: mocks.client.mockImplementation(actual.createPrismaClient) };
});
const env = {
  AWS_REGION: 'ap-southeast-1',
  DB_SECRET_ARN: 'db-reference',
  LICENSE_SIGNING_KEY_SECRET_ARN: 'license-reference',
  EXPORT_BUCKET_NAME: 'export-bucket',
  OTA_BUCKET_NAME: 'ota-bucket',
  MEDIA_BUCKET_NAME: 'media-bucket',
  OTA_SIGNING_KEY_ARN: 'signing-reference',
  USER_POOL_ID: 'ap-southeast-1_test',
  USER_POOL_CLIENT_ID: 'client',
  FDP_DB_POOL_MAX: '1',
  ENV_NAME: 'test',
  FDP_QA09_ENGINE_CPU_DIAGNOSIS: 'true',
  FDP_ADMIN_PARALLEL_SECRETS: 'true',
};
const setup = () => {
  vi.resetModules();
  vi.clearAllMocks();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  mocks.database.mockResolvedValue('postgresql://unused:unused@localhost/never-connect');
  mocks.license.mockResolvedValue('synthetic-license-secret');
};
const event = { path: '/api/v1/admin/contracts', httpMethod: 'GET', headers: { authorization: 'Bearer invalid' } };
afterEach(() => vi.unstubAllEnvs());
test('missing configuration prevents any secret/client work in actual Lambda entry', async () => {
  setup();
  vi.stubEnv('USER_POOL_CLIENT_ID', '');
  const { handler } = await import('../src/runtime/lambda-entry.js');
  assert.equal((await handler(event)).statusCode, 500);
  assert.equal(mocks.database.mock.calls.length, 0);
  assert.equal(mocks.license.mock.calls.length, 0);
  assert.equal(mocks.client.mock.calls.length, 0);
});
test('failed secret never publishes runtime/client; later request retries initialization without business work', async () => {
  setup();
  mocks.license.mockRejectedValueOnce(Error('private-secret-error'));
  const { handler } = await import('../src/runtime/lambda-entry.js');
  const failure = await handler(event);
  assert.equal(failure.statusCode, 500);
  assert.notInclude(failure.body, 'private-secret-error');
  assert.equal(mocks.client.mock.calls.length, 0);
  assert.equal((await handler(event)).statusCode, 401);
  assert.equal(mocks.client.mock.calls.length, 1);
  assert.equal(mocks.database.mock.calls.length, 2);
  assert.equal(mocks.license.mock.calls.length, 2);
});
test('concurrent initialization shares one handler/client and warm bad JWT never triggers engine preparation', async () => {
  setup();
  let release!: (value: string) => void;
  mocks.database.mockImplementationOnce(
    () =>
      new Promise<string>((r) => {
        release = r;
      }),
  );
  const { handler } = await import('../src/runtime/lambda-entry.js');
  const first = handler(event),
    second = handler(event);
  await Promise.resolve();
  release('postgresql://unused:unused@localhost/never-connect');
  assert.deepEqual(
    (await Promise.all([first, second])).map((r) => r.statusCode),
    [401, 401],
  );
  assert.equal(mocks.client.mock.calls.length, 1);
  assert.equal(mocks.database.mock.calls.length, 1);
  assert.equal(mocks.license.mock.calls.length, 1);
  const client = mocks.client.mock.results[0]?.value;
  const connect = vi.spyOn(client, '$connect');
  assert.equal((await handler(event)).statusCode, 401);
  assert.equal(connect.mock.calls.length, 0);
});
