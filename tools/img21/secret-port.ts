import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { TARGET, requireThat } from './contracts.js';
import type { SecretMaterial } from './license-verifier.js';
interface Transport {
  send(command: any, options: { abortSignal: AbortSignal }): Promise<any>;
}
export function createSecretPort(
  versionId: string,
  transport: Transport = new SecretsManagerClient({ region: TARGET.region, maxAttempts: 1 }),
) {
  return async (): Promise<SecretMaterial> => {
    const response = await transport.send(
      new GetSecretValueCommand({ SecretId: TARGET.licenseSecretArn, VersionId: versionId }),
      { abortSignal: AbortSignal.timeout(8000) },
    );
    requireThat(
      response.ARN === TARGET.licenseSecretArn &&
        response.VersionId === versionId &&
        typeof response.SecretString === 'string' &&
        Buffer.byteLength(response.SecretString) >= 32 &&
        Buffer.byteLength(response.SecretString) <= 65536,
      'EXACT_SECRET_VERSION_REQUIRED',
    );
    const key = Buffer.from(response.SecretString, 'utf8');
    response.SecretString = undefined;
    return { arn: TARGET.licenseSecretArn, versionId, key };
  };
}
