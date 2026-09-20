import { GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { assert, describe, expect, test } from 'vitest';
import { resolveDatabaseUrl } from '../src/database-secret.js';

describe('RDS Secrets Manager 运行时接线', () => {
  test('读取指定 Secret 并安全编码连接字段', async () => {
    const calls: unknown[] = [];
    const client = {
      send: async (command: GetSecretValueCommand) => {
        calls.push(command.input);
        return {
          SecretString: JSON.stringify({
            username: 'fdp user',
            password: 'p@ss/word',
            host: 'db.internal',
            port: 5432,
            dbname: 'fdp',
          }),
        };
      },
    } as unknown as SecretsManagerClient;
    await expect(resolveDatabaseUrl({ secretArn: 'arn:secret', client })).resolves.toBe(
      'postgresql://fdp%20user:p%40ss%2Fword@db.internal:5432/fdp?sslmode=verify-full',
    );
    assert.deepEqual(calls, [{ SecretId: 'arn:secret' }]);
  });

  test('字段缺失时失败关闭', async () => {
    const client = { send: async () => ({ SecretString: '{}' }) } as unknown as SecretsManagerClient;
    await expect(resolveDatabaseUrl({ secretArn: 'arn:secret', client })).rejects.toThrow(/缺少数据库连接字段/);
  });
});
