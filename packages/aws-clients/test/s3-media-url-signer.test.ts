import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { assert, describe, expect, test, vi } from 'vitest';
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
    // 固定 TTL 边界时钟，避免计算期间跨毫秒被向下取整为 3600。
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 9, 1));
    try {
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
      await expect(signer.signUpload({ ...valid, expiresAt: new Date(Date.now() + 3_601_000) })).rejects.toThrow(
        /TTL/u,
      );
    } finally {
      clock.mockRestore();
    }
  });
});

test('re-signing anchors actual SigV4 expiry before delayed credential resolution (offline static credentials)', async () => {
  const { S3Client } = await import('@aws-sdk/client-s3');
  let now = Date.parse('2026-11-06T08:00:00.650Z');
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const originalExpiry = new Date(now + 900000);
  const client = new S3Client({
    region: 'us-east-1',
    credentials: async () => {
      now += 5000;
      return { accessKeyId: 'LOCAL_TEST_KEY', secretAccessKey: 'LOCAL_TEST_SECRET' };
    },
  });
  const signer = createS3MediaUrlSigner({ bucket: 'local-test-media', client });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(
        await signer.signUpload({
          key: 'media/c/d/s/capture.jpg',
          expiresAt: originalExpiry,
          contentLength: 811,
          checksumSha256: 'ab'.repeat(32),
        }),
      );
      const date = url.searchParams.get('X-Amz-Date')!;
      const signedAt = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      expect(signedAt + Number(url.searchParams.get('X-Amz-Expires')) * 1000).toBeLessThanOrEqual(
        originalExpiry.getTime(),
      );
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');
      now += 60000;
    }
  } finally {
    clock.mockRestore();
    client.destroy();
  }
});
