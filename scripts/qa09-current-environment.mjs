import { readFileSync } from 'node:fs';
export const CURRENT_TEST_CONFIG = JSON.parse(
  readFileSync(new URL('../infra/environments/qa09-current-test.json', import.meta.url), 'utf8'),
);
export function validateCurrentEnvironment(config) {
  if (
    config.mode !== 'REAL_EXISTING_TEST_ENVIRONMENT' ||
    config.accountId !== '065986019555' ||
    config.region !== 'ap-southeast-1' ||
    config.stackName !== 'fdp-test-app' ||
    config.environment !== 'test' ||
    config.reuseExistingEnvironment !== true ||
    config.createSeparateEnvironment !== false ||
    config.syntheticResponsesAllowed !== false ||
    config.dataSeparation !== 'UNIQUE_RUN_PREFIX_AND_CREATED_ID_LEDGER'
  )
    throw Error('WRONG_EXISTING_TEST_ENVIRONMENT');
  if (
    config.authorization?.realBusinessTests !== true ||
    config.authorization?.ownTestDataWritesAndCleanup !== true ||
    ['cloudDeployment', 'databaseMigration', 'faultInjection', 'remotePush'].some(
      (key) => config.authorization[key] !== false,
    )
  )
    throw Error('INVALID_QA09_TEST_SCOPE');
  const faults = config.authorization.ownFixtureFaults;
  if (
    faults &&
    (faults.scope !== 'OWN_CREATED_IDS_ONLY' ||
      faults.sharedResourceChanges !== false ||
      faults.restoreAndAuditRequired !== true ||
      !Array.isArray(faults.actions) ||
      !faults.actions.length ||
      faults.actions.some((action) => !['EXPIRED_ESG_EXPORT_LEASE', 'OWN_QUEUE_REDELIVERY'].includes(action)))
  )
    throw Error('INVALID_OWN_FIXTURE_FAULT_SCOPE');
  return config;
}
validateCurrentEnvironment(CURRENT_TEST_CONFIG);
