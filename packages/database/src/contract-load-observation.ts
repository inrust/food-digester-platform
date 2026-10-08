import { AsyncLocalStorage } from 'node:async_hooks';
import {
  beginDataPathPhase,
  bindDataPathObservation,
  captureDataPathBoundary,
  recordContractLoadOwnership,
} from '@fdp/observability';

type Finish = ReturnType<typeof beginDataPathPhase>;
interface LoadScope {
  delegate: Finish;
  prepare?: Finish;
  result?: Finish;
  modelEntries: number;
  driverDispatches: number;
  transactional: boolean;
  completed: boolean;
  detailed?: boolean;
  submit?: Finish;
  await?: Finish;
  beforePg?: Finish;
  pg?: Finish;
  afterPg?: Finish;
  pgQueries: number;
  pgSettlements: number;
}
const loads = new AsyncLocalStorage<LoadScope>();

/** One existing contract findFirst; no eager query, compiler internals, retries or new pool. */
export async function observeContractLoad<T>(work: () => Promise<T>): Promise<T> {
  const start = captureDataPathBoundary();
  const outer = beginDataPathPhase('contract-load', { processCpu: true, startBoundary: start });
  const frame: LoadScope = {
    delegate: beginDataPathPhase('contract-load-delegate', { processCpu: true, startBoundary: start }),
    modelEntries: 0,
    driverDispatches: 0,
    transactional: false,
    completed: false,
    pgQueries: 0,
    pgSettlements: 0,
  };
  let failure: unknown;
  return loads.run(frame, async () => {
    try {
      return await work();
    } catch (error) {
      failure = error ?? new Error('CONTRACT_LOAD_FAILED');
      throw error;
    } finally {
      const end = captureDataPathBoundary();
      frame.completed = true;
      const boundary = failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED';
      frame.result?.(failure, boundary, end);
      frame.await?.(failure, boundary, end);
      frame.submit?.(failure, boundary, end);
      frame.prepare?.(failure, boundary, end);
      frame.delegate(failure, boundary, end);
      outer(failure, undefined, end);
      recordContractLoadOwnership(
        frame.modelEntries,
        frame.driverDispatches,
        frame.transactional,
        frame.detailed ? { pgQueries: frame.pgQueries, pgSettlements: frame.pgSettlements } : undefined,
      );
    }
  });
}

/** Public query extension entry, not a compiler-only or first-model-compilation claim. */
export function markContractLoadModelEntry(model: string | undefined, operation: string, detailed = false): void {
  const frame = loads.getStore();
  if (!frame || frame.completed || model !== 'Contract' || operation !== 'findFirst') return;
  frame.modelEntries++;
  if (frame.modelEntries !== 1) return;
  const boundary = captureDataPathBoundary();
  frame.detailed = detailed;
  if (detailed)
    frame.submit = beginDataPathPhase('contract-load-orm-submit', { processCpu: true, startBoundary: boundary });
  frame.prepare = beginDataPathPhase('contract-load-orm-prepare', { processCpu: true, startBoundary: boundary });
  frame.delegate(undefined, 'MODEL_EXTENSION_ENTERED', boundary);
}

/** Synchronous public query(args) return; preserve the original value/Promise and exception. */
export function observeContractLoadSubmission<T>(work: () => T): T {
  const frame = loads.getStore();
  if (!frame?.detailed || frame.completed) return work();
  try {
    const result = work();
    const returned = captureDataPathBoundary();
    frame.await = beginDataPathPhase('contract-load-orm-await', { processCpu: true, startBoundary: returned });
    frame.submit?.(undefined, 'CALL_RETURNED', returned);
    return result;
  } catch (error) {
    frame.submit?.(error ?? new Error('CONTRACT_SUBMISSION_FAILED'), 'OPERATION_FAILED');
    throw error;
  }
}

/** Called only by the leased pg port while its owning Contract adapter query is active. */
export function beginContractLoadPgQuery(): ((error?: unknown) => void) | undefined {
  const frame = loads.getStore();
  if (!frame?.detailed || frame.completed || !frame.beforePg) return undefined;
  frame.pgQueries++;
  if (frame.pgQueries !== 1) return undefined;
  const entered = captureDataPathBoundary();
  frame.pg = beginDataPathPhase('contract-load-driver-pg', { processCpu: true, startBoundary: entered });
  frame.beforePg(undefined, 'PG_DISPATCH', entered);
  return bindDataPathObservation((error) => {
    if (frame.completed) return;
    frame.pgSettlements++;
    if (frame.pgSettlements !== 1) return;
    const settled = captureDataPathBoundary();
    frame.afterPg = beginDataPathPhase('contract-load-driver-after-pg', { processCpu: true, startBoundary: settled });
    frame.pg?.(error, error === undefined ? 'PG_SETTLED' : 'OPERATION_FAILED', settled);
  });
}

/** Query settlement includes driver I/O and adapter decoding; does not isolate server execution. */
export function observeContractLoadDriver<T>(work: () => Promise<T>, transactional: boolean): Promise<T> {
  const frame = loads.getStore();
  if (!frame || frame.completed) return work();
  frame.driverDispatches++;
  if (frame.driverDispatches !== 1) return work();
  frame.transactional = transactional;
  const dispatch = captureDataPathBoundary();
  const query = beginDataPathPhase('contract-load-driver-query', { processCpu: true, startBoundary: dispatch });
  if (frame.detailed) {
    frame.beforePg = beginDataPathPhase('contract-load-driver-before-pg', {
      processCpu: true,
      startBoundary: dispatch,
    });
    frame.await?.(undefined, 'DRIVER_DISPATCH', dispatch);
  }
  frame.prepare?.(undefined, 'DRIVER_DISPATCH', dispatch);
  return (async () => {
    let failure: unknown;
    try {
      return await work();
    } catch (error) {
      failure = error ?? new Error('CONTRACT_QUERY_FAILED');
      throw error;
    } finally {
      const settled = captureDataPathBoundary();
      frame.afterPg?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.pg?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.beforePg?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.result = beginDataPathPhase('contract-load-result', { processCpu: true, startBoundary: settled });
      query(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
    }
  })();
}
