// Package alongside qa09-ca-root-repair.mjs, qa09-ca-chain-diagnostic.mjs and public truststore.pem.
// Deploy/invoke only in AWS after the exact temporary write permission plan is authorized.
import {
  SecretsManagerClient,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
} from '@aws-sdk/client-secrets-manager';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repairCaRoot } from './qa09-ca-root-repair.mjs';
const secretArn = 'arn:aws:secretsmanager:ap-southeast-1:065986019555:secret:fdp-test-device-ca-mecYC7';
const baselineVersion = 'c10bbb97-033c-4758-9bcb-e75bb6bd5fa9';
const keyArn = 'arn:aws:kms:ap-southeast-1:065986019555:key/22af85c4-76d3-40c9-a849-0621740afe6c';
const rootFingerprint =
  '85:24:E4:39:20:F2:EF:7B:F8:8F:BC:F5:AC:27:4B:58:0C:82:F8:C0:3F:3C:FF:5E:31:AA:6C:7C:BE:31:39:52';
const truststoreSha256 = '447dfa9a580c6bfd3126c7661519e46820f3e4919b1862f39e2d1683a349a0de';
const client = new SecretsManagerClient({ region: 'ap-southeast-1', maxAttempts: 1 });
export const handler = async (event) => {
  if (
    event?.operation !== 'REPAIR_CA_ROOT_ONLY' ||
    !/^[a-f0-9]{32}$/.test(event?.requestNonce ?? '') ||
    !/^[a-f0-9-]{36}$/.test(event?.candidateToken ?? '')
  )
    return { completed: false, errorCode: 'INVALID_REQUEST' };
  if (new Date() >= new Date('2026-10-03T00:00:00Z')) return { completed: false, errorCode: 'AUTHORIZATION_EXPIRED' };
  const send = (command) => client.send(command, { abortSignal: AbortSignal.timeout(10000) });
  try {
    const truststorePem = readFileSync(new URL('./truststore.pem', import.meta.url), 'utf8');
    if (createHash('sha256').update(truststorePem).digest('hex') !== truststoreSha256)
      return { completed: false, errorCode: 'TRUSTSTORE_DRIFT' };
    const store = {
      async describe() {
        const meta = await send(new DescribeSecretCommand({ SecretId: secretArn }));
        if (meta.ARN !== secretArn || meta.KmsKeyId !== keyArn) throw Error('CA_METADATA_DRIFT');
        return { VersionIdsToStages: meta.VersionIdsToStages };
      },
      get: (VersionId) => send(new GetSecretValueCommand({ SecretId: secretArn, VersionId })),
      put: (input) => send(new PutSecretValueCommand({ ...input, SecretId: secretArn })),
      move: (input) => send(new UpdateSecretVersionStageCommand({ ...input, SecretId: secretArn })),
    };
    const result = await repairCaRoot({
      store,
      baselineVersion,
      token: event.candidateToken,
      truststorePem,
      rootFingerprint,
    });
    return { ...result, requestNonce: event.requestNonce, finishedAt: new Date().toISOString() };
  } catch {
    return { completed: false, errorCode: 'AWS_REPAIR_HANDLER_FAILED', requestNonce: event.requestNonce };
  }
};
