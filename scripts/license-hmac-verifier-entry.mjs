/** Operations-deployed License-only entry. No secret export, signer import, DB access or IAM changes. */
import { runControlledA2 } from './qa09-a2-controlled-worker.mjs';
import { TEST_LICENSE_SECRET_ARN } from './qa09-device-license-verifier.mjs';

export async function verifyLicenseEvent(event, { applicationCommit, identity, loadSecret, now }) {
  if (
    !/^[a-f0-9]{40}$/.test(applicationCommit ?? '') ||
    event?.applicationCommit !== applicationCommit ||
    event?.operation !== 'LICENSE_VERIFY' ||
    Buffer.byteLength(JSON.stringify(event)) > 16384
  )
    throw Error('BOUND_LICENSE_ONLY_EVENT_REQUIRED');
  return runControlledA2(event, { identity, loadSecret, now });
}

export async function handler(event) {
  let sts, sm;
  try {
    const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
    const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
    const options = { region: 'ap-southeast-1', maxAttempts: 1 };
    sts = new STSClient(options);
    sm = new SecretsManagerClient(options);
    return await verifyLicenseEvent(event, {
      applicationCommit: process.env.FDP_LICENSE_VERIFIER_APPLICATION_COMMIT,
      identity: () => sts.send(new GetCallerIdentityCommand({}), { abortSignal: AbortSignal.timeout(15000) }),
      loadSecret: async (arn) => {
        if (arn !== TEST_LICENSE_SECRET_ARN) throw Error('EXACT_TEST_SECRET_REQUIRED');
        const result = await sm.send(new GetSecretValueCommand({ SecretId: arn, VersionStage: 'AWSCURRENT' }), {
          abortSignal: AbortSignal.timeout(15000),
        });
        return { arn: result.ARN, versionId: result.VersionId, value: result.SecretString };
      },
    });
  } catch {
    return { gate: 'FAIL_CLOSED', code: 'LICENSE_VERIFICATION_NOT_PROVEN', keyExported: false };
  } finally {
    sts?.destroy();
    sm?.destroy();
  }
}
