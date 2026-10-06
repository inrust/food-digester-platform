import { AsyncLocalStorage } from 'node:async_hooks';
export type DataPathPhase =
  | 'runtime-initialize'
  | 'admin-authenticate'
  | 'envelope'
  | 'identity'
  | 'payload-validation'
  | 'db-transaction'
  | 'db-transaction-callback'
  | 'db-transaction-open'
  | 'db-transaction-finish'
  | 'contract-load'
  | 'contract-version-update'
  | 'contract-readback'
  | 'audit-success-write'
  | 'audit-failure-write'
  | 'audit-list-query'
  | 'audit-detail-query'
  | 'audit-view'
  | 'db-lock'
  | 'db-assignment'
  | 'db-receipt'
  | 'db-business'
  | 'db-outbox'
  | 'db-gap'
  | 'telemetry-aggregate'
  | 'telemetry-archive-outbox'
  | 'duplicate-readback'
  | 'console-read'
  | 'console-device'
  | 'console-latest-state'
  | 'console-hour-selection'
  | 'console-buckets'
  | 'console-consumables'
  | 'console-alarms'
  | 'console-contract'
  | 'console-esg'
  | 'console-media'
  | 'response-serialize';
export interface DataPathIds {
  readonly lambdaRequestId?: string | undefined;
  readonly gatewayRequestId?: string | undefined;
  readonly operationId?: string | undefined;
  readonly sqsMessageId?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly topicType?: string | undefined;
  readonly seq?: number | undefined;
  readonly receivedAtMs?: number | undefined;
  readonly occurredAtMs?: number | undefined;
  readonly coldStart?: boolean | undefined;
}
type LogRow = Readonly<Record<string, string | number | boolean>>;
interface Trace {
  ids: DataPathIds;
  emit: (row: LogRow) => void;
  clock: () => number;
  receiptId?: string | undefined;
  receiptOutcome?: string | undefined;
}
const storage = new AsyncLocalStorage<Trace>();
const safeId = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : 'unknown');
function emit(event: string, detail: LogRow) {
  const trace = storage.getStore();
  if (!trace) return;
  const ids = trace.ids;
  try {
    trace.emit({
      event,
      lambdaRequestId: safeId(ids.lambdaRequestId),
      gatewayRequestId: safeId(ids.gatewayRequestId),
      operationId: safeId(ids.operationId),
      sqsMessageId: safeId(ids.sqsMessageId),
      deviceId: safeId(ids.deviceId),
      messageId: safeId(ids.messageId),
      topicType: safeId(ids.topicType),
      ...(Number.isSafeInteger(ids.seq) && ids.seq! >= 0 ? { seq: ids.seq! } : {}),
      ...(Number.isSafeInteger(ids.receivedAtMs) && ids.receivedAtMs! >= 0 ? { receivedAtMs: ids.receivedAtMs! } : {}),
      ...(Number.isSafeInteger(ids.occurredAtMs) && ids.occurredAtMs! >= 0 ? { occurredAtMs: ids.occurredAtMs! } : {}),
      coldStart: ids.coldStart === true,
      ...detail,
    });
  } catch {
    /* Observability must never change transaction ownership, business results or retries. */
  }
}
export function withDataPathTrace<T>(
  ids: DataPathIds,
  work: () => T,
  output?: (row: LogRow) => void,
  clock?: () => number,
): T {
  const parent = storage.getStore();
  return storage.run(
    {
      ids: { ...parent?.ids, ...ids },
      emit: output ?? parent?.emit ?? (() => {}),
      clock: clock ?? parent?.clock ?? (() => performance.now()),
    },
    work,
  );
}
export function setDataPathMessage(
  ids: Pick<DataPathIds, 'deviceId' | 'messageId' | 'topicType' | 'seq' | 'receivedAtMs' | 'occurredAtMs'>,
): void {
  const t = storage.getStore();
  if (t) t.ids = { ...t.ids, ...ids };
}
/** Finish is idempotent; no SQL, payload or arbitrary error messages enter the log. */
export function beginDataPathPhase(phase: DataPathPhase): (error?: unknown) => void {
  const trace = storage.getStore();
  if (!trace) return () => {};
  const start = trace.clock(),
    startedAt = new Date().toISOString();
  let finished = false;
  return (error?: unknown) => {
    if (finished) return;
    finished = true;
    const code = (error as { code?: unknown } | undefined)?.code;
    const errorCode =
      error === undefined
        ? 'NONE'
        : typeof code === 'string' && (/^P[0-9]{4}$/.test(code) || code === 'VERSION_CONFLICT')
          ? code
          : 'DATA_PATH_PHASE_FAILED';
    emit('data-path.phase.completed', {
      phase,
      durationMs: Math.max(0, Math.round(trace.clock() - start)),
      outcome: error === undefined ? 'PASS' : 'FAIL',
      errorCode,
      startedAt,
      completedAt: new Date().toISOString(),
      includesConnectionWait:
        phase.startsWith('console-') ||
        phase === 'db-transaction' ||
        phase === 'db-transaction-open' ||
        phase === 'audit-list-query' ||
        phase === 'audit-detail-query' ||
        phase === 'audit-failure-write',
    });
  };
}
export async function observeDataPathPhase<T>(phase: DataPathPhase, work: () => Promise<T>): Promise<T> {
  const finish = beginDataPathPhase(phase);
  try {
    const result = await work();
    finish();
    return result;
  } catch (error) {
    finish(error ?? new Error('DATA_PATH_PHASE_FAILED'));
    throw error;
  }
}
export function observeReceiptResult(
  outcome: 'PROCESSED' | 'DUPLICATE_SKIPPED',
  receiptId: unknown,
  rootTransaction: boolean,
): void {
  const trace = storage.getStore();
  if (trace) {
    trace.receiptId = safeId(receiptId);
    trace.receiptOutcome = outcome;
  }
  emit('ingestion.receipt.completed', {
    receiptId: safeId(receiptId),
    receiptOutcome: outcome,
    commitScope: rootTransaction ? 'ROOT_TRANSACTION_COMPLETED' : 'ENCLOSING_TRANSACTION_CALLBACK_ONLY',
    completedAt: new Date().toISOString(),
  });
}
export function observeRecordResult(disposition: 'PROCESSED' | 'VALIDATED_ONLY' | 'QUARANTINED' | 'RETRY'): void {
  const trace = storage.getStore();
  emit('ingestion.record.completed', {
    disposition,
    receiptId: safeId(trace?.receiptId),
    receiptOutcome: trace?.receiptOutcome ?? 'NOT_AVAILABLE',
    completedAt: new Date().toISOString(),
    businessDispatchCompleted: disposition === 'PROCESSED',
  });
}

export function observeDataPathSyncPhase<T>(phase: DataPathPhase, work: () => T): T {
  const trace = storage.getStore();
  if (!trace) return work();
  const start = trace.clock();
  const startedAt = new Date().toISOString();
  let outcome = 'PASS';
  try {
    return work();
  } catch (error) {
    outcome = 'FAIL';
    throw error;
  } finally {
    emit('data-path.phase.completed', {
      phase,
      durationMs: Math.max(0, Math.round(trace.clock() - start)),
      outcome,
      errorCode: outcome === 'FAIL' ? 'DATA_PATH_PHASE_FAILED' : 'NONE',
      startedAt,
      completedAt: new Date().toISOString(),
      includesConnectionWait: false,
    });
  }
}
