/**
 * SEC-01 数据密钥提供者（信封加密的数据密钥来源）。
 *
 * 生产实现为 KMS：GenerateDataKey 返回明文数据密钥 + 密文数据密钥，
 * 明文仅在内存中使用，落库的是密文数据密钥（随包裹一起打包，见 secure-package/envelope）。
 * 测试实现见 @fdp/auth 的 createLocalTestKeyProvider（禁止生产使用）。
 */
import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';

export interface GeneratedDataKey {
  /** 明文数据密钥：仅内存使用，使用后即弃，禁止落库/日志。 */
  readonly plaintextKey: Uint8Array;
  /** 密文数据密钥（KMS CiphertextBlob）：可随包裹存储。 */
  readonly encryptedKey: Uint8Array;
}

export interface DataKeyProvider {
  /** 主密钥标识（KMS Key ARN 或测试标识），随包裹记录用于审计。 */
  readonly keyId: string;
  generateDataKey(): Promise<GeneratedDataKey>;
  decryptDataKey(encryptedKey: Uint8Array): Promise<Uint8Array>;
}

export interface KmsDataKeyProviderConfig {
  /** KMS Key ARN 或 alias（IAC-01：fdp-{env}-cert-package）。 */
  readonly keyId: string;
  /** 注入的 KMS 客户端（测试可 mock）；缺省按 region 创建。 */
  readonly client?: KMSClient;
  readonly region?: string;
}

export function createKmsDataKeyProvider(config: KmsDataKeyProviderConfig): DataKeyProvider {
  const client = config.client ?? new KMSClient(config.region ? { region: config.region } : {});
  return {
    keyId: config.keyId,
    async generateDataKey() {
      const out = await client.send(new GenerateDataKeyCommand({ KeyId: config.keyId, KeySpec: 'AES_256' }));
      if (!out.Plaintext || !out.CiphertextBlob) {
        throw new Error('KMS GenerateDataKey 返回不完整');
      }
      return { plaintextKey: out.Plaintext, encryptedKey: out.CiphertextBlob };
    },
    async decryptDataKey(encryptedKey: Uint8Array) {
      const out = await client.send(new DecryptCommand({ CiphertextBlob: encryptedKey, KeyId: config.keyId }));
      if (!out.Plaintext) {
        throw new Error('KMS Decrypt 返回不完整');
      }
      return out.Plaintext;
    },
  };
}
