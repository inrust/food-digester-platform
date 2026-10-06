import { observeDatabaseEnginePreparation } from '@fdp/database';

/** No SQL/pre-read. Only the test API may enable this; caller runs after signed JWT authentication. */
export function resolveEngineCpuDiagnosis(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.FDP_QA09_ENGINE_CPU_DIAGNOSIS;
  if (value !== undefined && value !== 'false' && value !== 'true') throw new Error('INVALID_ENGINE_CPU_DIAGNOSIS');
  if (value === 'true' && (env.ENV_NAME !== 'test' || env.FDP_DB_POOL_MAX !== '1'))
    throw new Error('ENGINE_CPU_DIAGNOSIS_REQUIRES_TEST_POOL1');
  return value === 'true';
}

/** One successful preparation per existing client; failure retains original error and allows a later request. */
export function createAuthenticatedEngineDiagnostic(
  enabled: boolean,
  client: { $connect(): Promise<void> },
): () => Promise<void> {
  let preparation: Promise<void> | undefined;
  return async () => {
    if (!enabled) return;
    preparation ??= observeDatabaseEnginePreparation(() => client.$connect()).catch((error) => {
      preparation = undefined;
      throw error;
    });
    await preparation;
  };
}
