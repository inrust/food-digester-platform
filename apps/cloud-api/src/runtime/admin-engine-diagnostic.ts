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

/** Candidate requires the same explicit engine preparation as C0; only test/pool1. */
export function resolveAuthenticatedPreconnect(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.FDP_QA09_AUTHENTICATED_PRECONNECT;
  if (value !== undefined && value !== 'false' && value !== 'true') throw new Error('INVALID_AUTHENTICATED_PRECONNECT');
  if (value === 'true' && (!resolveEngineCpuDiagnosis(env) || env.ENV_NAME !== 'test' || env.FDP_DB_POOL_MAX !== '1'))
    throw new Error('PRECONNECT_REQUIRES_TEST_POOL1_ENGINE');
  return value === 'true';
}

/** Explicit R1 only: the same test/pool1/engine/preconnect budget as R0. */
export function resolveAccountReadCandidate(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.FDP_QA09_ACCOUNT_READ_CANDIDATE;
  if (value !== undefined && value !== 'false' && value !== 'true') throw new Error('INVALID_ACCOUNT_READ_CANDIDATE');
  if (value === 'true' && !resolveAuthenticatedPreconnect(env))
    throw new Error('ACCOUNT_READ_REQUIRES_TEST_POOL1_ENGINE_PRECONNECT');
  return value === 'true';
}

/** Default off; identical test/pool1/engine/preconnect guard for both R0 and R1. */
export function resolveContractLoadDetail(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.FDP_QA09_CONTRACT_LOAD_DETAIL;
  if (value !== undefined && value !== 'false' && value !== 'true') throw new Error('INVALID_CONTRACT_LOAD_DETAIL');
  if (value === 'true' && !resolveAuthenticatedPreconnect(env))
    throw new Error('CONTRACT_LOAD_DETAIL_REQUIRES_TEST_POOL1_ENGINE_PRECONNECT');
  return value === 'true';
}
