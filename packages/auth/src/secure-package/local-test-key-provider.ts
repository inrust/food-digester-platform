/**
 * SEC-01 测试专用密钥适配器。
 *
 * 警告：仅用于单元/集成测试（PGlite 环境），主密钥由测试字符串派生，
 * 不具备 KMS 的访问控制与审计能力；生产必须使用 createKmsDataKeyProvider。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { DataKeyProvider, GeneratedDataKey } from '@fdp/aws-clients';

export function createLocalTestKeyProvider(secret: string): DataKeyProvider {
  const masterKey = createHash('sha256').update(`local-test-only:${secret}`, 'utf8').digest();

  const seal = (plaintext: Uint8Array): Uint8Array => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
    return Buffer.concat([iv, cipher.update(Buffer.from(plaintext)), cipher.final(), cipher.getAuthTag()]);
  };

  const open = (sealed: Uint8Array): Uint8Array => {
    const buffer = Buffer.from(sealed);
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(buffer.length - 16);
    const ciphertext = buffer.subarray(12, buffer.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  };

  return {
    keyId: 'local-test-key',
    generateDataKey(): Promise<GeneratedDataKey> {
      const plaintextKey = randomBytes(32);
      return Promise.resolve({ plaintextKey, encryptedKey: seal(plaintextKey) });
    },
    decryptDataKey(encryptedKey: Uint8Array): Promise<Uint8Array> {
      return Promise.resolve(open(encryptedKey));
    },
  };
}
