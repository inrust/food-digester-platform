import { PACKAGE_NAME as DATABASE_PACKAGE } from '@fdp/database';
import { PACKAGE_NAME as AWS_CLIENTS_PACKAGE } from '@fdp/aws-clients';

/**
 * summary-worker 生产组合根（BE-ESG-01）。
 */
export const SERVICE_NAME = 'summary-worker';

export function serviceLayers(): readonly string[] {
  return [DATABASE_PACKAGE, AWS_CLIENTS_PACKAGE];
}

export * from './aggregation/index.js';
