import { createPreviewAwarePrismaClient, createLiveImageStoreFromEnv, resolveDatabaseUrl } from '@fdp/aws-clients';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { createControlledWriter } from './controlled-writer.js';
import { createIdentityPort } from './identity-port.js';
import { runtimeManifest } from './runtime.js';
import { checkInvocation, checkWindow, parseWriteRequest, requireThat, TARGET } from './contracts.js';
import type { Invocation } from './contracts.js';
export async function handler(event: unknown, context: Invocation) {
  let client: ReturnType<typeof createPreviewAwarePrismaClient> | undefined;
  const secretClient = new SecretsManagerClient({ region: TARGET.region, maxAttempts: 1 });
  try {
    const bound = runtimeManifest(process.env);
    checkInvocation(bound, 'writer', context);
    const request = parseWriteRequest(event, bound);
    if (request.action !== 'READ_OPERATION') checkWindow(bound, Date.now());
    requireThat(
      process.env.LIVE_IMAGE_CONTROL_TABLE === TARGET.controlTable &&
        process.env.LIVE_IMAGE_PAYLOAD_TABLE === TARGET.payloadTable &&
        process.env.FDP_DB_POOL_MAX === '1',
      'AUTHORITY_CONFIG_REQUIRED',
    );
    const url = await resolveDatabaseUrl({
      secretArn: TARGET.dbSecretArn,
      client: secretClient,
      region: TARGET.region,
    });
    client = createPreviewAwarePrismaClient(url);
    return await createControlledWriter(bound, {
      client,
      control: createLiveImageStoreFromEnv(),
      identity: createIdentityPort(),
      now: Date.now,
    })(event, context);
  } catch {
    return { status: 'REJECTED', code: 'CONTROLLED_WRITER_UNAVAILABLE', operationId: '' };
  } finally {
    await client?.$disconnect().catch(() => undefined);
    secretClient.destroy();
  }
}
