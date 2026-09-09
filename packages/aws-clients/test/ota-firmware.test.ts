import { VerifyCommand, type KMSClient } from '@aws-sdk/client-kms';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { assert, describe, test } from 'vitest';
import {
  createKmsFirmwareSignatureVerifier,
  createOtaFirmwareS3Ports,
  OTA_FIRMWARE_SIGNATURE_ALGORITHM,
  OTA_FIRMWARE_TRUST_ROOT,
} from '../src/ota-firmware.js';

describe('OTA 固件 AWS 生产适配器', () => {
  test('S3 对象校验、流式 Hash 与 15 分钟 PUT/GET 预签名', async () => {
    const sent: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sent.push(command);
        if (command instanceof HeadObjectCommand) return { ContentLength: 3 };
        if (command instanceof GetObjectCommand) {
          return {
            Body: (async function* () {
              yield Buffer.from('abc');
            })(),
          };
        }
        return {};
      },
    } as unknown as S3Client;
    const signed: Array<{ command: unknown; expiresIn: number }> = [];
    const ports = createOtaFirmwareS3Ports({
      bucket: 'fdp-ota',
      client,
      now: () => new Date('2026-09-09T00:00:00Z'),
      presign: async (_client, command, expiresIn) => {
        signed.push({ command, expiresIn });
        return `https://signed.example/${signed.length}`;
      },
    });

    assert.deepEqual(await ports.storage.statObject('firmware-packages/a'), { sizeBytes: 3 });
    assert.equal(
      await ports.storage.computeSha256('firmware-packages/a'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    await ports.uploadUrlSigner.signUpload({
      key: 'firmware-packages/a',
      expiresAt: new Date('2026-09-09T00:15:00Z'),
    });
    await ports.downloadUrlSigner.signDownload({
      key: 'firmware-packages/a',
      expiresAt: new Date('2026-09-09T00:15:00Z'),
    });

    assert.instanceOf(sent[0], HeadObjectCommand);
    assert.instanceOf(sent[1], GetObjectCommand);
    assert.instanceOf(signed[0]?.command, PutObjectCommand);
    assert.instanceOf(signed[1]?.command, GetObjectCommand);
    assert.deepEqual(
      signed.map((item) => item.expiresIn),
      [900, 900],
    );
  });

  test('KMS verifier 固定算法、信任根、编码与消息字节', async () => {
    const sent: unknown[] = [];
    const verifier = createKmsFirmwareSignatureVerifier({
      keyId: 'arn:aws:kms:ap-southeast-1:111122223333:key/key-1',
      client: {
        async send(command: unknown) {
          sent.push(command);
          return { SignatureValid: true };
        },
      } as unknown as KMSClient,
    });
    assert.equal(
      await verifier.verify({
        payload: 'FDP-OTA-SIG-v1\nmodel=BNX-100',
        signature: Buffer.alloc(256, 1).toString('base64'),
        trustRoot: OTA_FIRMWARE_TRUST_ROOT,
        encoding: 'base64',
      }),
      true,
    );
    const command = sent[0] as VerifyCommand;
    assert.instanceOf(command, VerifyCommand);
    assert.equal(command.input.SigningAlgorithm, OTA_FIRMWARE_SIGNATURE_ALGORITHM);
    assert.equal(Buffer.from(command.input.Message as Uint8Array).toString('utf8'), 'FDP-OTA-SIG-v1\nmodel=BNX-100');
    assert.equal(
      await verifier.verify({
        payload: 'x',
        signature: 'eA==',
        trustRoot: 'UNTRUSTED',
        encoding: 'base64',
      }),
      false,
    );
    assert.equal(sent.length, 1);
  });
});
