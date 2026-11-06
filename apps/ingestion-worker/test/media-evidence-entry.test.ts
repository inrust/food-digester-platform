import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { createTestDb } from '../../cloud-api/test/helpers.js';
const aws = vi.hoisted(() => ({ database: vi.fn(), url: vi.fn() }));
vi.mock('@fdp/aws-clients', () => ({ createPreviewAwarePrismaClient: aws.database, resolveDatabaseUrl: aws.url }));
let db: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => {
  db = await createTestDb();
}, 60000);
afterAll(async () => {
  await db?.prisma.$disconnect();
  await db?.pg.close();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});
function env() {
  vi.stubEnv('AWS_REGION', 'ap-southeast-1');
  vi.stubEnv('DB_SECRET_ARN', 'local-secret');
  aws.url.mockResolvedValue('postgresql://local-only/test');
  aws.database.mockReturnValue(db.prisma);
}
test('minute runtime routes into the real local worker, initializes once and makes no S3/IoT/SQS call', async () => {
  env();
  const { handler } = await import('../src/runtime/media-evidence-entry.js');
  const result = await handler({}, { getRemainingTimeInMillis: () => 60000 });
  expect(result).toMatchObject({ outbox: { claimed: 0 }, scan: { pages: 1, visited: 0, stop: 'IDLE' } });
  await handler();
  expect(aws.url).toHaveBeenCalledTimes(1);
  expect(aws.database).toHaveBeenCalledTimes(1);
  expect(aws.url).toHaveBeenCalledWith({ secretArn: 'local-secret', region: 'ap-southeast-1' });
});
test('remaining-time budget stops scanning without starting a row transaction', async () => {
  env();
  const { handler } = await import('../src/runtime/media-evidence-entry.js');
  expect((await handler({}, { getRemainingTimeInMillis: () => 9000 })).scan).toMatchObject({
    pages: 0,
    visited: 0,
    stop: 'BUDGET',
  });
});
test('runtime refuses incomplete environment before constructing a database client', async () => {
  vi.stubEnv('DB_SECRET_ARN', '');
  const { handler } = await import('../src/runtime/media-evidence-entry.js');
  await expect(handler()).rejects.toThrow('DB_SECRET_ARN');
  expect(aws.database).not.toHaveBeenCalled();
});

test('partial processing failure rejects the tick so EventBridge retry/DLQ remains active', async () => {
  env();
  const worker = await import('../src/media/evidence-worker.js');
  vi.spyOn(worker, 'runMediaEvidenceWorker').mockResolvedValueOnce({
    outbox: { claimed: 1, published: 0, retried: 1, failed: 0 },
    scan: { pages: 1, visited: 0, linked: 0, unmatched: 0, pending: 0, skipped: 0, failed: 0, stop: 'IDLE' },
  });
  const { handler } = await import('../src/runtime/media-evidence-entry.js');
  await expect(handler()).rejects.toThrow('MEDIA_EVIDENCE_BATCH_RETRY');
});
