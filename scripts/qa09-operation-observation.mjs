// Only structured, allowlisted metadata crosses the target evidence boundary.
const names = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'AbortError',
  'TimeoutError',
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedException',
  'NotAuthorizedException',
  'ExpiredTokenException',
  'UserNotFoundException',
  'ResourceNotFoundException',
  'InvalidParameterException',
  'ThrottlingException',
  'TooManyRequestsException',
  'RequestTimeout',
  'RequestTimeoutException',
  'ServiceUnavailableException',
  'InternalErrorException',
  'NetworkingError',
  'CredentialsProviderError',
]);
const codes = new Set([
  ...names,
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  'CLI_READ_TIMEOUT',
  'CLI_NETWORK_ERROR',
  'CLI_FAILED',
  'SSO_SESSION_EXPIRED',
  'CLI_INVALID_JSON',
  'CLI_OUTPUT_LIMIT',
  'FIXTURE_BUILD_NOT_VERIFIED',
  'FIXTURE_BUILD_BINDING_MISMATCH',
  'FIXTURE_BUILD_NOT_FOUND',
  'BUILD_TIMEOUT',
  'FIXTURE_RESULT_NOT_VERIFIED',
  'FIXTURE_RESULT_READ_TIMEOUT',
  'FIXTURE_FRAME_TRUNCATED',
]);
const operations = new Set([
  'batch-get-builds',
  'batch-get-projects',
  'start-build',
  'update-project',
  'create-project',
  'get-caller-identity',
  'get-log-events',
]);
const safeCode = (v) => {
  if (codes.has(v)) return v;
  const match = typeof v === 'string' && v.match(/^AWS_([a-z-]+)_([A-Za-z_]+)$/);
  return match && operations.has(match[1]) && codes.has(match[2]) ? v : null;
};
const integer = (v, max) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : null);
const requestId = (v) => (typeof v === 'string' && /^[a-f0-9-]{16,64}$/i.test(v) ? v : null);
export function safeOperationError(error) {
  const cli = error?.cliObservation;
  return {
    code: safeCode(error?.code) ?? safeCode(error?.message) ?? 'UNCLASSIFIED_FAILURE',
    errorName: names.has(error?.name) ? error.name : 'UNCLASSIFIED_ERROR',
    causeCode: safeCode(error?.cause?.code),
    requestId: requestId(error?.$metadata?.requestId),
    httpStatusCode: integer(error?.$metadata?.httpStatusCode, 599),
    attempts: integer(error?.$metadata?.attempts, 100),
    totalRetryDelay: integer(error?.$metadata?.totalRetryDelay, 3600000),
    ...(cli
      ? {
          cli: {
            exitStatus: integer(cli.exitStatus, 255),
            signal: ['SIGTERM', 'SIGKILL', 'SIGINT'].includes(cli.signal) ? cli.signal : null,
            spawnErrorCode: codes.has(cli.spawnErrorCode) ? cli.spawnErrorCode : null,
            stderrBytes: integer(cli.stderrBytes, 16 * 1024 * 1024),
            durationMs: integer(cli.durationMs, 180000),
          },
        }
      : {}),
  };
}
export function createOperationObserver(rows, save = () => {}, now = () => performance.now()) {
  return async (operation, run) => {
    if (!/^[A-Za-z][A-Za-z0-9:._-]{0,159}$/.test(operation)) throw Error('INVALID_OBSERVATION_OPERATION');
    const row = { sequence: rows.length + 1, operation, startedAt: new Date().toISOString(), result: 'RUNNING' };
    rows.push(row);
    save();
    const start = now();
    try {
      const value = await run();
      row.result = 'PASS';
      row.requestId = requestId(value?.$metadata?.requestId);
      return value;
    } catch (error) {
      row.result = 'FAIL';
      row.failure = safeOperationError(error);
      if (operation === 'cognito:AdminGetUserCommand' && error?.name === 'UserNotFoundException')
        row.expectedOutcome = 'ABSENT_IDENTITY';
      throw error;
    } finally {
      row.durationMs = Math.max(0, Math.round(now() - start));
      row.finishedAt = new Date().toISOString();
      save();
    }
  };
}
export function classifySafeCliError(stderr, error) {
  if (
    /Token has expired and refresh failed|Error when retrieving token from sso|SSO session.*expired/i.test(stderr ?? '')
  )
    return 'SSO_SESSION_EXPIRED';
  const service = stderr?.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1];
  if (names.has(service)) return service;
  if (error?.code === 'ETIMEDOUT' || /Read timeout on endpoint URL|ReadTimeoutError/i.test(stderr ?? ''))
    return 'CLI_READ_TIMEOUT';
  if (error?.code === 'ENOBUFS') return 'CLI_OUTPUT_LIMIT';
  if (/Could not connect to the endpoint URL|Connection was closed before|Connection reset by peer/i.test(stderr ?? ''))
    return 'CLI_NETWORK_ERROR';
  return 'CLI_FAILED';
}
export function transientFixtureRead(error) {
  const code = safeOperationError(error).code;
  return /(?:^|_)(CLI_READ_TIMEOUT|CLI_NETWORK_ERROR|ThrottlingException|TooManyRequestsException|RequestTimeout|RequestTimeoutException|ServiceUnavailableException|NetworkingError)$/.test(
    code,
  );
}
// Continue deletion and absence verification after sign-out failure, but never admit a full cleanup PASS.
export async function cleanupIdentityOperations(observe, { globalSignOut, deleteUser, getUser }) {
  const result = { globalSignOut: 'NOT_RUN', deletion: 'NOT_RUN', absence: 'NOT_RUN', failures: [] };
  for (const [field, operation, run] of [
    ['globalSignOut', 'cognito:GlobalSignOut', globalSignOut],
    ['deletion', 'cognito:AdminDeleteUserCommand', deleteUser],
    ['absence', 'cognito:AdminGetUserCommand', getUser],
  ]) {
    try {
      await observe(operation, run);
      result[field] = field === 'absence' ? 'FAIL' : 'PASS';
    } catch (error) {
      if (field === 'absence' && error.name === 'UserNotFoundException') {
        result[field] = 'PASS';
        result.absenceProof = 'UserNotFoundException';
      } else {
        result[field] = 'FAIL';
        result.failures.push({ operation, ...safeOperationError(error) });
      }
    }
  }
  result.result = ['globalSignOut', 'deletion', 'absence'].every((field) => result[field] === 'PASS') ? 'PASS' : 'FAIL';
  return result;
}
