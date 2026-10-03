export type CommandPhase =
  | 'db-validation'
  | 'db-lease'
  | 'db-attempt'
  | 'iot-publish'
  | 'db-finalize'
  | 'db-secret'
  | 'iot-endpoint'
  | 'sqs-consumption'
  | 'scheduled-scan';
export type CommandPhaseObserver = <T>(phase: CommandPhase, work: () => Promise<T>, commandId?: string) => Promise<T>;

/** Fixed schema only: never forward exception messages, command payloads or Secret values. */
export function createCommandPhaseObserver(
  emit: (row: Readonly<Record<string, string | number | boolean>>) => void,
  requestId: string,
  coldStart: boolean,
  clock = () => performance.now(),
): CommandPhaseObserver {
  return async (phase, work, commandId) => {
    const started = clock();
    let outcome = 'PASS',
      errorCode = 'NONE';
    try {
      return await work();
    } catch (error) {
      outcome = 'FAIL';
      const name = error instanceof Error ? error.name : '';
      errorCode = [
        'AccessDeniedException',
        'ThrottlingException',
        'TimeoutError',
        'PrismaClientKnownRequestError',
        'PrismaClientInitializationError',
      ].includes(name)
        ? name
        : 'COMMAND_PHASE_FAILED';
      throw error;
    } finally {
      try {
        emit({
          event: 'command.phase.completed',
          phase,
          durationMs: Math.max(0, Math.round(clock() - started)),
          lambdaRequestId: /^[a-f0-9-]{36}$/.test(requestId) ? requestId : 'unknown',
          coldStart,
          outcome,
          errorCode,
          ...(commandId && /^[A-Z0-9][A-Z0-9-]{0,127}$/.test(commandId) ? { commandId } : {}),
        });
      } catch {
        /* observation never changes publish ownership or retries */
      }
    }
  };
}
