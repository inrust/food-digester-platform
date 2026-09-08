import { createAwsIotProvisioningClient, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import type { RetirementTimeoutEvaluation } from '../admin/device-retirement/service.js';
import { createRetirementTimeoutLambdaHandler } from './retirement-timeout-lambda.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

const batchSize = (): number => {
  const value = Number(process.env.RETIREMENT_TIMEOUT_BATCH_SIZE ?? 100);
  if (!Number.isInteger(value) || value < 1 || value > 1000) {
    throw new Error('Lambda 环境变量 RETIREMENT_TIMEOUT_BATCH_SIZE 必须为 1 到 1000 的整数');
  }
  return value;
};

let evaluate: (() => Promise<RetirementTimeoutEvaluation>) | undefined;

async function initialize(): Promise<() => Promise<RetirementTimeoutEvaluation>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const limit = batchSize();
  return createRetirementTimeoutLambdaHandler(client, {
    batchSize: limit,
    revoker: createAwsIotProvisioningClient({ region }),
  });
}

/** EventBridge 生产入口：按 DEC-014 精确 72 小时边界完成未确认退役。 */
export async function handler(): Promise<RetirementTimeoutEvaluation> {
  evaluate ??= await initialize();
  return evaluate();
}
