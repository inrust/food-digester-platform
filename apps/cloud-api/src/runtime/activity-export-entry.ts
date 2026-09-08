import { createS3ActivityExportPorts, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { processActivityExportJobs } from '../admin/device-console/export.js';
import type { ActivityExportProcessResult } from '../admin/device-console/export.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

const positiveInteger = (name: string, fallback: number): number => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Lambda 环境变量 ${name} 必须为正整数`);
  return value;
};

let run: (() => Promise<ActivityExportProcessResult>) | undefined;

async function initialize(): Promise<() => Promise<ActivityExportProcessResult>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const ports = createS3ActivityExportPorts({ bucket: required('EXPORT_BUCKET_NAME'), region });
  const batchSize = positiveInteger('ACTIVITY_EXPORT_BATCH_SIZE', 10);
  const leaseSeconds = positiveInteger('ACTIVITY_EXPORT_LEASE_SECONDS', 300);
  return () => processActivityExportJobs({ client, ...ports }, { batchSize, leaseSeconds });
}

/** EventBridge 生产入口：处理 PENDING 及租约过期的 PROCESSING 活动导出任务。 */
export async function handler(): Promise<ActivityExportProcessResult> {
  run ??= await initialize();
  return run();
}
