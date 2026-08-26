import { PACKAGE_NAME as DATABASE_PACKAGE } from '@fdp/database';
import { PACKAGE_NAME as AWS_CLIENTS_PACKAGE } from '@fdp/aws-clients';

/**
 * archive-worker 构建骨架（ENG-01）。
 * 原始消息归档（S3）与重放在 BE-ARC/BE-RPL 系列任务实现。
 */
export const SERVICE_NAME = 'archive-worker';

export function serviceLayers(): readonly string[] {
  return [DATABASE_PACKAGE, AWS_CLIENTS_PACKAGE];
}
