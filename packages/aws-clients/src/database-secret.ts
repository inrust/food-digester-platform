import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface DatabaseSecretResolverConfig {
  readonly secretArn: string;
  readonly client?: SecretsManagerClient;
  readonly region?: string;
}

interface RdsDatabaseSecret {
  readonly username: string;
  readonly password: string;
  readonly host: string;
  readonly port: number;
  readonly dbname: string;
}

function parseSecret(secretString: string): RdsDatabaseSecret {
  let value: unknown;
  try {
    value = JSON.parse(secretString);
  } catch {
    throw new Error('RDS Secret 不是有效 JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('RDS Secret 结构无效');
  const secret = value as Record<string, unknown>;
  const port = typeof secret.port === 'string' ? Number(secret.port) : secret.port;
  if (
    typeof secret.username !== 'string' ||
    typeof secret.password !== 'string' ||
    typeof secret.host !== 'string' ||
    typeof secret.dbname !== 'string' ||
    typeof port !== 'number' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new Error('RDS Secret 缺少数据库连接字段');
  }
  return { username: secret.username, password: secret.password, host: secret.host, port, dbname: secret.dbname };
}

/** 仅在 Lambda 冷启动内存中把 RDS 托管 Secret 转为 Prisma 使用的连接 URL。 */
export async function resolveDatabaseUrl(config: DatabaseSecretResolverConfig): Promise<string> {
  const client = config.client ?? new SecretsManagerClient(config.region ? { region: config.region } : {});
  const response = await client.send(new GetSecretValueCommand({ SecretId: config.secretArn }));
  if (!response.SecretString) throw new Error('RDS Secret 不包含 SecretString');
  const secret = parseSecret(response.SecretString);
  return `postgresql://${encodeURIComponent(secret.username)}:${encodeURIComponent(secret.password)}@${secret.host}:${secret.port}/${encodeURIComponent(secret.dbname)}?sslmode=require`;
}
