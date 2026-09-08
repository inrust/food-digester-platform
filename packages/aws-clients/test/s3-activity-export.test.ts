import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { assert, describe, test } from 'vitest';
import { createS3ActivityExportPorts } from '../src/s3-activity-export.js';

describe('BE-DEV-05 S3 活动导出生产适配器', () => {
  test('CSV 写入隔离前缀并生成受限时长的 GetObject 预签名 URL', async () => {
    const sent: unknown[] = [];
    const client = {
      async send(command: unknown) {
        sent.push(command);
        return {};
      },
    } as unknown as S3Client;
    let signed: { command: GetObjectCommand; expiresIn: number } | undefined;
    const ports = createS3ActivityExportPorts({
      bucket: 'fdp-test-export',
      client,
      now: () => new Date('2026-09-08T08:00:00Z'),
      presign: async (_client, command, expiresIn) => {
        signed = { command, expiresIn };
        return 'https://signed.example/export.csv';
      },
    });

    await ports.storage.put({ key: 'activity-exports/job-1.csv', body: 'a,b\r\n', contentType: 'text/csv' });
    const url = await ports.urlSigner.sign({
      key: 'activity-exports/job-1.csv',
      expiresAt: new Date('2026-09-08T08:15:00Z'),
    });

    assert.instanceOf(sent[0], PutObjectCommand);
    assert.deepInclude((sent[0] as PutObjectCommand).input, {
      Bucket: 'fdp-test-export',
      Key: 'activity-exports/job-1.csv',
      Body: 'a,b\r\n',
      ContentType: 'text/csv',
    });
    assert.equal(url, 'https://signed.example/export.csv');
    assert.equal(signed?.expiresIn, 900);
    assert.instanceOf(signed?.command, GetObjectCommand);
    assert.deepInclude(signed?.command.input, {
      Bucket: 'fdp-test-export',
      Key: 'activity-exports/job-1.csv',
    });
  });
});
