/**
 * SEC-01 信封加密打包格式（AES-256-GCM）。
 *
 * 布局：[u16be 密文数据密钥长度][密文数据密钥][12B IV][16B GCM Tag][密文]，
 * 整体存入 device_certificates.package_ciphertext（DB-01）。
 * 明文数据密钥与包裹明文仅在内存出现，绝不落库。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { SecurePackageError } from './errors.js';

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const LENGTH_PREFIX = 2;

export function packEnvelope(plaintextKey: Uint8Array, encryptedKey: Uint8Array, payload: Uint8Array): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(plaintextKey), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(payload)), cipher.final()]);
  const tag = cipher.getAuthTag();

  const lengthPrefix = Buffer.alloc(LENGTH_PREFIX);
  lengthPrefix.writeUInt16BE(encryptedKey.length);
  return Buffer.concat([lengthPrefix, Buffer.from(encryptedKey), iv, tag, ciphertext]);
}

export function unpackEnvelope(plaintextKey: Uint8Array, blob: Uint8Array): Buffer {
  const buffer = Buffer.from(blob);
  if (buffer.length < LENGTH_PREFIX) {
    throw new SecurePackageError('CORRUPT_PACKAGE', 'certificate package blob is truncated');
  }
  const keyLength = buffer.readUInt16BE(0);
  const headerLength = LENGTH_PREFIX + keyLength + IV_LENGTH + TAG_LENGTH;
  if (buffer.length < headerLength) {
    throw new SecurePackageError('CORRUPT_PACKAGE', 'certificate package blob is truncated');
  }
  const iv = buffer.subarray(LENGTH_PREFIX + keyLength, LENGTH_PREFIX + keyLength + IV_LENGTH);
  const tag = buffer.subarray(LENGTH_PREFIX + keyLength + IV_LENGTH, headerLength);
  const ciphertext = buffer.subarray(headerLength);

  try {
    const decipher = createDecipheriv('aes-256-gcm', Buffer.from(plaintextKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    // GCM 认证失败：密文被篡改或密钥错误；不泄露细节
    throw new SecurePackageError('CORRUPT_PACKAGE', 'certificate package integrity check failed');
  }
}

/** 从打包 Blob 中提取密文数据密钥（解密前需先经 DataKeyProvider 解出明文密钥）。 */
export function extractEncryptedKey(blob: Uint8Array): Uint8Array {
  const buffer = Buffer.from(blob);
  if (buffer.length < LENGTH_PREFIX) {
    throw new SecurePackageError('CORRUPT_PACKAGE', 'certificate package blob is truncated');
  }
  const keyLength = buffer.readUInt16BE(0);
  if (buffer.length < LENGTH_PREFIX + keyLength) {
    throw new SecurePackageError('CORRUPT_PACKAGE', 'certificate package blob is truncated');
  }
  return buffer.subarray(LENGTH_PREFIX, LENGTH_PREFIX + keyLength);
}
