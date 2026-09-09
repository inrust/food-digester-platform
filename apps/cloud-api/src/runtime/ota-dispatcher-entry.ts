import { createAwsIotProvisioningClient, createIotDataPublisher, resolveDatabaseUrl } from '@fdp/aws-clients';
import { createPrismaClient } from '@fdp/database';
import { dispatchPendingOtaTargets } from '../ota/publisher.js';
import type { OtaDispatchResult } from '../ota/publisher.js';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
  return value;
};

let dispatch: (() => Promise<OtaDispatchResult[]>) | undefined;

async function initialize(): Promise<() => Promise<OtaDispatchResult[]>> {
  const region = required('AWS_REGION');
  const client = createPrismaClient(await resolveDatabaseUrl({ secretArn: required('DB_SECRET_ARN'), region }));
  const endpoint = await createAwsIotProvisioningClient({ region }).getDataEndpoint();
  const mqtt = createIotDataPublisher({ endpoint, region });
  return () => dispatchPendingOtaTargets({ client, mqtt, downloadGrantBaseUrl: required('DEVICE_API_BASE_URL') });
}

/** EventBridge 生产入口：RUNNING Campaign 的到期 PENDING Target → IoT ota Topic。 */
export async function handler(): Promise<OtaDispatchResult[]> {
  dispatch ??= await initialize();
  return dispatch();
}
