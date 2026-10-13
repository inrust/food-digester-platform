/** Runs only inside a separately authorized test verifier/signer role; never exports the HMAC key. */
import { createHash, createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  controlledLicenseVerification,
  validateVerifierInput,
  TEST_LICENSE_SECRET_ARN,
} from './qa09-device-license-verifier.mjs';
import { prepareFirmwareFixture, signFirmwareFixture, TEST_OTA_KEY_ARN } from './qa09-firmware-fixture.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
export function a2SourceHashes() {
  return Object.fromEntries(
    ['qa09-a2-controlled-worker.mjs', 'qa09-device-license-verifier.mjs', 'qa09-firmware-fixture.mjs'].map((name) => [
      name,
      hash(readFileSync(new URL(name, import.meta.url))),
    ]),
  );
}
export async function runControlledA2(input, ports) {
  const now = ports.now?.() ?? Date.now();
  if (
    !['LICENSE_VERIFY', 'FIRMWARE_SIGN'].includes(input?.operation) ||
    JSON.stringify(input.sourceHashes) !== JSON.stringify(a2SourceHashes()) ||
    !/^qa09-[a-f0-9]{16}$/.test(input.prefix ?? '') ||
    !/^[a-f0-9]{40}$/.test(input.applicationCommit ?? '') ||
    !/^[a-f0-9]{32}$/.test(input.nonce ?? '') ||
    !Number.isFinite(input.expiresAtMs) ||
    input.expiresAtMs <= now ||
    input.expiresAtMs > now + 300000
  )
    throw Error('BOUND_CURRENT_A2_INPUT_REQUIRED');
  if (input.operation === 'LICENSE_VERIFY') validateVerifierInput(input, now);
  const identity = await ports.identity();
  const role =
    input.operation === 'LICENSE_VERIFY' ? 'fdp-test-qa09-license-verifier-role' : 'fdp-test-qa09-firmware-signer-role';
  if (
    identity.Account !== '065986019555' ||
    !new RegExp('^arn:aws:sts::065986019555:assumed-role/' + role + '/[A-Za-z0-9+=,.@_-]{1,64}$').test(
      identity.Arn ?? '',
    )
  )
    throw Error('DEDICATED_AUTHORIZED_A2_ROLE_REQUIRED');
  let result;
  if (input.operation === 'LICENSE_VERIFY')
    result = await controlledLicenseVerification(input, {
      loadSecret: ports.loadSecret,
      now: ports.now ?? (() => Date.now()),
    });
  else {
    const fixture = prepareFirmwareFixture(input.prefix);
    const pub = await ports.getPublicKey(TEST_OTA_KEY_ARN);
    if (
      pub.KeyId !== TEST_OTA_KEY_ARN ||
      pub.KeyUsage !== 'SIGN_VERIFY' ||
      pub.KeySpec !== 'RSA_2048' ||
      !pub.SigningAlgorithms?.includes('RSASSA_PKCS1_V1_5_SHA_256')
    )
      throw Error('BOUND_TEST_OTA_PUBLIC_KEY_REQUIRED');
    const publicKey = createPublicKey({ key: Buffer.from(pub.PublicKey), format: 'der', type: 'spki' });
    result = {
      ...(await signFirmwareFixture(fixture, { sign: ports.sign, publicKey })),
      bytesBase64: fixture.bytes.toString('base64'),
      publicKeySha256: hash(pub.PublicKey),
    };
  }
  if ((ports.now?.() ?? Date.now()) >= input.expiresAtMs) throw Error('A2_INPUT_EXPIRED_DURING_VERIFICATION');
  return {
    ...result,
    operation: input.operation,
    prefix: input.prefix,
    applicationCommit: input.applicationCommit,
    nonce: input.nonce,
    expiresAtMs: input.expiresAtMs,
    sourceHashes: a2SourceHashes(),
    executedAt: new Date(ports.now?.() ?? Date.now()).toISOString(),
    controlledRole: role,
    physicalDeviceAttested: false,
    fullQa09Accepted: false,
  };
}
async function command() {
  let chunks = [],
    size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16384) throw Error('A2_INPUT_LIMIT');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  chunks = [];
  let input;
  try {
    input = JSON.parse(bytes.toString('utf8'));
  } finally {
    bytes.fill(0);
  }
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const { KMSClient, GetPublicKeyCommand, SignCommand } = await import('@aws-sdk/client-kms');
  const options = { region: 'ap-southeast-1', maxAttempts: 1 },
    secrets = new SecretsManagerClient(options),
    kms = new KMSClient(options);
  const send = (client, Cmd, value) => client.send(new Cmd(value), { abortSignal: AbortSignal.timeout(15000) });
  const result = await runControlledA2(input, {
    identity: async () => {
      const result = await promisify(execFile)(
        'aws',
        [
          'sts',
          'get-caller-identity',
          '--region',
          'ap-southeast-1',
          '--output',
          'json',
          '--no-cli-pager',
          '--cli-connect-timeout',
          '3',
          '--cli-read-timeout',
          '8',
        ],
        { timeout: 15000, maxBuffer: 16384, env: { ...process.env, AWS_MAX_ATTEMPTS: '1' } },
      );
      return JSON.parse(result.stdout);
    },
    loadSecret: async (arn) => {
      if (arn !== TEST_LICENSE_SECRET_ARN) throw Error('EXACT_TEST_SECRET_REQUIRED');
      const value = await send(secrets, GetSecretValueCommand, { SecretId: arn, VersionStage: 'AWSCURRENT' });
      return { arn: value.ARN, versionId: value.VersionId, value: value.SecretString };
    },
    getPublicKey: (key) => send(kms, GetPublicKeyCommand, { KeyId: key }),
    sign: (value) => send(kms, SignCommand, value),
  });
  process.stdout.write(JSON.stringify(result) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  command().catch(() => {
    process.stderr.write('A2_CONTROLLED_VERIFICATION_FAILED_NO_SECRET_OUTPUT\n');
    process.exitCode = 1;
  });
