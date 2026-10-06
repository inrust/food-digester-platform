import { observeDataPathPhase } from '@fdp/observability';
import { resolveDatabasePoolMax } from '@fdp/database';

export function readAdminRuntimeConfig(env: Readonly<Record<string, string | undefined>>) {
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`缺少 Lambda 环境变量 ${name}`);
    return value;
  };
  // Validate all initialization prerequisites before starting either remote Secret operation.
  const config = {
    region: required('AWS_REGION'),
    databaseSecretArn: required('DB_SECRET_ARN'),
    licenseSecretArn: required('LICENSE_SIGNING_KEY_SECRET_ARN'),
    exportBucket: required('EXPORT_BUCKET_NAME'),
    otaBucket: required('OTA_BUCKET_NAME'),
    mediaBucket: required('MEDIA_BUCKET_NAME'),
    otaSigningKeyArn: required('OTA_SIGNING_KEY_ARN'),
    userPoolId: required('USER_POOL_ID'),
    clientId: required('USER_POOL_CLIENT_ID'),
  };
  resolveDatabasePoolMax(env.FDP_DB_POOL_MAX);
  const mode = env.FDP_ADMIN_PARALLEL_SECRETS;
  if (mode !== undefined && mode !== 'true' && mode !== 'false') throw new Error('INVALID_ADMIN_PARALLEL_SECRETS');
  return { ...config, parallelSecrets: mode !== 'false' };
}

/** Same two references, no retries. Both parallel operations settle before selecting the original DB-first error. */
export async function resolveAdminRuntimeSecrets(
  config: ReturnType<typeof readAdminRuntimeConfig>,
  deps: {
    database: (args: { secretArn: string; region: string }) => Promise<string>;
    license: (args: { secretArn: string; region: string }) => Promise<string>;
  },
) {
  const database = () =>
    observeDataPathPhase('runtime-database-secret', async () =>
      deps.database({ secretArn: config.databaseSecretArn, region: config.region }),
    );
  const license = () =>
    observeDataPathPhase('runtime-license-secret', async () =>
      deps.license({ secretArn: config.licenseSecretArn, region: config.region }),
    );
  if (!config.parallelSecrets) return { databaseUrl: await database(), licenseSigningKey: await license() };
  const [db, key] = await Promise.allSettled([database(), license()]);
  if (db.status === 'rejected') throw db.reason;
  if (key.status === 'rejected') throw key.reason;
  return { databaseUrl: db.value, licenseSigningKey: key.value };
}
