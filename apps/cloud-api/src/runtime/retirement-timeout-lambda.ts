import type { DbClient } from '@fdp/database';
import { evaluateRetirementTimeouts } from '../admin/device-retirement/service.js';
import type { RetirementTimeoutEvaluation } from '../admin/device-retirement/service.js';

export type RetirementTimeoutEvaluator = (
  client: DbClient,
  options: { readonly batchSize: number },
) => Promise<RetirementTimeoutEvaluation>;

/** 将 EventBridge 调用确定性映射到 DEC-014 evaluator，便于生产接线负测。 */
export function createRetirementTimeoutLambdaHandler(
  client: DbClient,
  options: { readonly batchSize: number; readonly evaluator?: RetirementTimeoutEvaluator },
): () => Promise<RetirementTimeoutEvaluation> {
  const evaluator = options.evaluator ?? evaluateRetirementTimeouts;
  return () => evaluator(client, { batchSize: options.batchSize });
}
