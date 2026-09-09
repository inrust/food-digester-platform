import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { assert, describe, expect, test } from 'vitest';
import { createS3MediaUrlSigner } from '../src/s3-media-url-signer.js';

describe('Media S3 URL 生产适配器', () => {
  test('PUT 绑定 Bucket、受控 Key、精确长度、SHA-256 与短 TTL；GET 复用受控边界', async () => {
    const signed: Array<{ command: unknown; expiresIn: number }> = [];
    const signer = createS3MediaUrlSigner({
      bucket: 'fdp-media',
      client: {} as S3Client,
      presign: async (_client, command, options) => {
        signed.push({ command, expiresIn: options?.expiresIn ?? 0 });
        return `https://signed.example/${signed.length}`;
      },
    });
    const expiresAt = new Date(Date.now() + 900_000);
    await signer.signUpload({
      key: 'media/customer-1/device-1/session-1/snap.jpg',
      expiresAt,
      contentLength: 2049,
      checksumSha256: 'ab'.repeat(32),
    });
    await signer.signDownload({ key: 'media/customer-1/device-1/session-1/snap.jpg', expiresAt });

    const put = signed[0]?.command as PutObjectCommand;
    assert.instanceOf(put, PutObjectCommand);
    assert.equal(put.input.Bucket, 'fdp-media');
    assert.equal(put.input.ContentLength, 2049);
    assert.equal(put.input.ChecksumSHA256, Buffer.from('ab'.repeat(32), 'hex').toString('base64'));
    assert.instanceOf(signed[1]?.command, GetObjectCommand);
    assert.ok(signed.every((item) => item.expiresIn >= 899 && item.expiresIn <= 900));
  });

  test('任意 Key、非法长度、非法 checksum 与超长 TTL 均失败关闭', async () => {
    const signer = createS3MediaUrlSigner({ bucket: 'fdp-media', client: {} as S3Client, presign: async () => '' });
    const valid = {
      key: 'media/c/d/s/f.jpg',
      expiresAt: new Date(Date.now() + 900_000),
      contentLength: 1,
      checksumSha256: '00'.repeat(32),
    };
    await expect(signer.signUpload({ ...valid, key: '../escape' })).rejects.toThrow(/outside/u);
    await expect(signer.signUpload({ ...valid, contentLength: 0 })).rejects.toThrow(/length/u);
    await expect(signer.signUpload({ ...valid, checksumSha256: 'bad' })).rejects.toThrow(/checksum/u);
    await expect(signer.signUpload({ ...valid, expiresAt: new Date(Date.now() + 3_601_000) })).rejects.toThrow(/TTL/u);
  });
});
