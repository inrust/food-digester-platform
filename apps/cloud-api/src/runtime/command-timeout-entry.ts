import { resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { evaluateCommandTimeouts } from '../admin/command/timeout.js';
import type { TimeoutEvaluationResult } from '../admin/command/timeout.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let evaluate: (() => Promise<TimeoutEvaluationResult>) | undefined;

async function initialize(): Promise<() => Promise<TimeoutEvaluationResult>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  return () => evaluateCommandTimeouts({ client });
}

/** EventBridge 生产入口：到期未完成 Command → TIMED_OUT。 */
export async function handler(): Promise<TimeoutEvaluationResult> {
  evaluate ??= await initialize();
  return evaluate();
}
