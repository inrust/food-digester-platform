import { createPreviewAwarePrismaClient, resolveDatabaseUrl } from '@fdp/aws-clients';
import type { DbClient } from '@fdp/database';
import { createRedactingLogger } from '@fdp/observability';
import { runMediaEvidenceWorker } from '../media/evidence-worker.js';
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};
let client: DbClient | undefined;
/** EventBridge minute tick: durable first-attempt fallback and bounded retries/expiry. */
export async function handler(_event?: unknown, context?: { getRemainingTimeInMillis(): number }) {
  client ??= createPreviewAwarePrismaClient(
    await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region: required('AWS_REGION') }),
  );
  const started = performance.now();
  const result = await runMediaEvidenceWorker(
    { client },
    {
      shouldContinue: () =>
        performance.now() - started < 45000 && (context?.getRemainingTimeInMillis() ?? Infinity) > 10000,
    },
  );
  createRedactingLogger(console).info(JSON.stringify({ event: 'media.evidence.batch.completed', ...result }));
  if (result.scan.failed || result.outbox.retried || result.outbox.failed)
    throw new Error('MEDIA_EVIDENCE_BATCH_RETRY');
  return result;
}
