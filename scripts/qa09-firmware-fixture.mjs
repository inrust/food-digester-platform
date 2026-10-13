/** A signed cloud protocol fixture is not a physical-device executable. */
import { createHash, verify, constants } from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
export const TEST_OTA_KEY_ARN = 'arn:aws:kms:ap-southeast-1:065986019555:key/2f3b0c18-1618-4547-8188-59cd4be554f9';
export function prepareFirmwareFixture(prefix) {
  if (!/^qa09-[a-f0-9]{16}$/.test(prefix)) throw Error('OWN_FIRMWARE_PREFIX_REQUIRED');
  const bytes = Buffer.from(
    JSON.stringify({ format: 'QA09_CLOUD_PROTOCOL_FIXTURE_V1', prefix, physicalExecutable: false }) + '\n',
  );
  const fields = { model: 'BNX-100', version: prefix, packageType: 'FIRMWARE', sha256: hash(bytes) };
  const payload = [
    'FDP-OTA-SIG-v1',
    ...['model', 'version', 'packageType', 'sha256'].map((key) => key + '=' + fields[key]),
  ].join('\n');
  return {
    bytes,
    fields,
    sizeBytes: bytes.length,
    payload,
    payloadSha256: hash(payload),
    keyArn: TEST_OTA_KEY_ARN,
    signingAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
    messageType: 'RAW',
    scope: 'CLOUD_OTA_PROTOCOL_ONLY_NOT_FLASHABLE',
  };
}
export async function signFirmwareFixture(fixture, { sign, publicKey }) {
  if (
    fixture.keyArn !== TEST_OTA_KEY_ARN ||
    fixture.sizeBytes !== fixture.bytes.length ||
    fixture.payload !==
      [
        'FDP-OTA-SIG-v1',
        ...['model', 'version', 'packageType', 'sha256'].map((key) => key + '=' + fixture.fields[key]),
      ].join('\n') ||
    fixture.fields.sha256 !== hash(fixture.bytes) ||
    fixture.payloadSha256 !== hash(fixture.payload)
  )
    throw Error('FIRMWARE_FIXTURE_BINDING_DRIFT');
  const signed = await sign({
    KeyId: TEST_OTA_KEY_ARN,
    Message: Buffer.from(fixture.payload),
    MessageType: 'RAW',
    SigningAlgorithm: 'RSASSA_PKCS1_V1_5_SHA_256',
  });
  if (
    signed.KeyId !== TEST_OTA_KEY_ARN ||
    signed.SigningAlgorithm !== 'RSASSA_PKCS1_V1_5_SHA_256' ||
    !signed.Signature ||
    signed.Signature.length !== 256 ||
    !verify(
      'RSA-SHA256',
      Buffer.from(fixture.payload),
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      signed.Signature,
    )
  )
    throw Error('TRUSTED_TEST_FIRMWARE_SIGNATURE_REQUIRED');
  return {
    ...fixture.fields,
    sizeBytes: fixture.sizeBytes,
    signature: Buffer.from(signed.Signature).toString('base64'),
    keyArn: TEST_OTA_KEY_ARN,
    payloadSha256: fixture.payloadSha256,
    scope: fixture.scope,
    gate: 'PASS_KMS_SIGNED_CLOUD_FIXTURE_LOCAL_PUBLIC_KEY_VERIFIED',
    physicalExecutable: false,
    fullQa09Accepted: false,
  };
}
