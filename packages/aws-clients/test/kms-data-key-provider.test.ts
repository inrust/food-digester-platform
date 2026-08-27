/**
 * SEC-01 KMS DataKeyProvider 测试：mock KMS 客户端验证命令接线（无网络）。
 */
import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms';
import type { KMSClient } from '@aws-sdk/client-kms';
import { assert, describe, expect, test } from 'vitest';
import { createKmsDataKeyProvider } from '../src/kms-data-key-provider.js';

const KEY_ARN = 'arn:aws:kms:ap-southeast-1:123456789012:key/00000000-0000-0000-0000-000000000000';

function mockKmsClient(): { client: KMSClient; calls: { name: string; input: Record<string, unknown> }[] } {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const client = {
    send: async (command: GenerateDataKeyCommand | DecryptCommand) => {
      calls.push({ name: command.constructor.name, input: command.input as Record<string, unknown> });
      if (command instanceof GenerateDataKeyCommand) {
        return { Plaintext: new Uint8Array(32).fill(1), CiphertextBlob: new Uint8Array([9, 9, 9]) };
      }
      return { Plaintext: new Uint8Array(32).fill(2) };
    },
  } as unknown as KMSClient;
  return { client, calls };
}

describe('createKmsDataKeyProvider', () => {
  test('generateDataKey 使用 AES_256 并返回明文+密文数据密钥', async () => {
    const { client, calls } = mockKmsClient();
    const provider = createKmsDataKeyProvider({ keyId: KEY_ARN, client });
    const key = await provider.generateDataKey();
    assert.equal(provider.keyId, KEY_ARN);
    assert.equal(key.plaintextKey.length, 32);
    assert.deepEqual([...key.encryptedKey], [9, 9, 9]);
    assert.equal(calls[0]?.name, 'GenerateDataKeyCommand');
    assert.deepEqual(calls[0]?.input, { KeyId: KEY_ARN, KeySpec: 'AES_256' });
  });

  test('decryptDataKey 传递密文与 KeyId', async () => {
    const { client, calls } = mockKmsClient();
    const provider = createKmsDataKeyProvider({ keyId: KEY_ARN, client });
    const plaintext = await provider.decryptDataKey(new Uint8Array([1, 2, 3]));
    assert.deepEqual([...plaintext], new Array(32).fill(2));
    assert.equal(calls[0]?.name, 'DecryptCommand');
    assert.equal(calls[0]?.input.KeyId, KEY_ARN);
    assert.deepEqual([...(calls[0]?.input.CiphertextBlob as Uint8Array)], [1, 2, 3]);
  });

  test('KMS 返回不完整时抛错（不静默降级）', async () => {
    const client = { send: async () => ({}) } as unknown as KMSClient;
    const provider = createKmsDataKeyProvider({ keyId: KEY_ARN, client });
    await expect(provider.generateDataKey()).rejects.toThrow(/返回不完整/);
    await expect(provider.decryptDataKey(new Uint8Array([1]))).rejects.toThrow(/返回不完整/);
  });
});
