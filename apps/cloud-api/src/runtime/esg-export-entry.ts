import { createS3ActivityExportPorts, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { processEsgExportJobs } from '../admin/esg/export-service.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let run: (() => Promise<number>) | undefined;

async function initialize() {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const ports = createS3ActivityExportPorts({ bucket: required('EXPORT_BUCKET_NAME'), region });
  const batchSize = Number(process.env.ESG_EXPORT_BATCH_SIZE ?? 10);
  const leaseSeconds = Number(process.env.ESG_EXPORT_LEASE_SECONDS ?? 300);
  return () => processEsgExportJobs({ client, ...ports, leaseSeconds }, batchSize);
}

/** EventBridge 生产入口：处理 PENDING 与租约过期的 PROCESSING ESG 导出任务。 */
export async function handler(): Promise<number> {
  run ??= await initialize();
  return run();
}
