import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, test, assert } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { createS3MediaObjectStorage } from '../src/index.js';

describe('BE-IOT-09 S3 MediaObjectStorage', () => {
  test('HeadObject 返回大小，GetObject 以流式内容重算 SHA-256', async () => {
    const body = Buffer.from('media-object-body');
    const calls: string[] = [];
    const client = {
      async send(command: object) {
        calls.push(command.constructor.name);
        if (command.constructor.name === 'HeadObjectCommand') return { ContentLength: body.length };
        return { Body: Readable.from([body.subarray(0, 5), body.subarray(5)]) };
      },
    } as unknown as S3Client;
    const storage = createS3MediaObjectStorage({ bucket: 'media-bucket', client });
    assert.deepEqual(await storage.statObject('media/c/d/s/f.jpg'), { sizeBytes: body.length });
    assert.equal(await storage.computeSha256('media/c/d/s/f.jpg'), createHash('sha256').update(body).digest('hex'));
    assert.deepEqual(calls, ['HeadObjectCommand', 'GetObjectCommand']);
  });

  test('S3 404 稳定映射为对象不存在', async () => {
    const client = {
      async send() {
        throw { name: 'NotFound', $metadata: { httpStatusCode: 404 } };
      },
    } as unknown as S3Client;
    const storage = createS3MediaObjectStorage({ bucket: 'media-bucket', client });
    assert.equal(await storage.statObject('missing'), null);
    assert.equal(await storage.computeSha256('missing'), null);
  });
});
