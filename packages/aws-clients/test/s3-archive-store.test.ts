import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { S3Client } from '@aws-sdk/client-s3';
import { assert, describe, test } from 'vitest';
import { createS3ArchiveObjectReader } from '../src/s3-archive-store.js';

describe('S3 archive reader', () => {
  test('展开所有分页、稳定排序 Key，并读取对象字节', async () => {
    const calls: unknown[] = [];
    const client = {
      async send(command: unknown) {
        calls.push(command);
        if (command instanceof ListObjectsV2Command) {
          return command.input.ContinuationToken
            ? { Contents: [{ Key: 'prefix/b.json.gz' }], IsTruncated: false }
            : {
                Contents: [{ Key: 'prefix/c.json.gz' }, { Key: 'prefix/a.json.gz' }],
                IsTruncated: true,
                NextContinuationToken: 'next',
              };
        }
        return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
      },
    } as unknown as S3Client;
    const reader = createS3ArchiveObjectReader({ bucket: 'raw-bucket', client });

    assert.deepEqual(await reader.listKeys('prefix/'), ['prefix/a.json.gz', 'prefix/b.json.gz', 'prefix/c.json.gz']);
    assert.deepEqual(await reader.getObject('prefix/a.json.gz'), new Uint8Array([1, 2, 3]));
    assert.instanceOf(calls[0], ListObjectsV2Command);
    assert.instanceOf(calls[1], ListObjectsV2Command);
    assert.instanceOf(calls[2], GetObjectCommand);
  });
});
