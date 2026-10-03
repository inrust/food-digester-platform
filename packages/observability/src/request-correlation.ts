export interface RequestCorrelation {
  readonly gatewayRequestId?: string | undefined;
  readonly gatewayExtendedRequestId?: string | undefined;
  readonly lambdaRequestId?: string | undefined;
  readonly operationId?: string | undefined;
}
/** Only fixed fields are accepted; caller event/error/body is never spread into logs. */
export async function observeRequest<T extends { readonly statusCode: number }>(
  ids: RequestCorrelation,
  run: () => Promise<T>,
  emit: (value: Readonly<Record<string, string | number>>) => void,
  clock = () => performance.now(),
): Promise<T> {
  const started = clock();
  let status: number | string = 'UNHANDLED';
  try {
    const result = await run();
    status = result.statusCode;
    return result;
  } finally {
    const safe = (v: string | undefined, extended = false) =>
      v && (extended ? /^[A-Za-z0-9+/=_-]{1,128}$/ : /^[A-Za-z0-9_-]{1,128}$/).test(v) ? v : 'unknown';
    try {
      emit({
        event: 'admin.request.completed',
        gatewayRequestId: safe(ids.gatewayRequestId),
        gatewayExtendedRequestId: safe(ids.gatewayExtendedRequestId, true),
        lambdaRequestId: safe(ids.lambdaRequestId),
        operationId: safe(ids.operationId),
        status,
        elapsedMs: Math.max(0, Math.round(clock() - started)),
      });
    } catch {
      /* Logging must not turn a committed write into an API failure. */
    }
  }
}
