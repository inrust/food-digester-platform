import { createHttpsWebhookSender, createSesEmailSender, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { dispatchPendingNotifications, retryFailedDeliveries } from '../notification/business-notifier.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let run: (() => Promise<unknown>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const deps = {
    client,
    emailSender: createSesEmailSender({ fromAddress: required('BUSINESS_EMAIL_FROM'), region }),
    webhookSender: createHttpsWebhookSender({
      allowedHosts: required('BUSINESS_WEBHOOK_ALLOWED_HOSTS')
        .split(',')
        .map((value) => value.trim()),
    }),
    batchSize: Number(process.env.BUSINESS_NOTIFICATION_BATCH_SIZE ?? 50),
    maxAttempts: Number(process.env.BUSINESS_NOTIFICATION_MAX_ATTEMPTS ?? 5),
    leaseSeconds: Number(process.env.BUSINESS_NOTIFICATION_LEASE_SECONDS ?? 60),
  };
  return async () => ({ retry: await retryFailedDeliveries(deps), dispatch: await dispatchPendingNotifications(deps) });
}

/** EventBridge 生产入口：派发业务告警并原子领取失败重试。 */
export async function handler(): Promise<unknown> {
  run ??= await initialize();
  return run();
}
