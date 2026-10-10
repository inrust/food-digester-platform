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
  awaitQueue?: Finish;
  awaitAfterQueue?: Finish;
  beforePg?: Finish;
  pg?: Finish;
  afterPg?: Finish;
  pgQueries: number;
  pgSettlements: number;
  publicBoundaries?: boolean;
  driverSubmit?: Finish;
  driverAwait?: Finish;
  pgSubmit?: Finish;
  pgAwait?: Finish;
  resultToModel?: Finish;
  resultAfterModel?: Finish;
  driverReturns: number;
  pgReturns: number;
  modelResumes: number;
  modelResumeObserved: boolean;
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
    driverReturns: 0,
    pgReturns: 0,
    modelResumes: 0,
    modelResumeObserved: false,
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
      frame.resultToModel?.(failure, boundary, end);
      frame.resultAfterModel?.(failure, boundary, end);
      frame.result?.(failure, boundary, end);
      frame.awaitQueue?.(failure, boundary, end);
      frame.awaitAfterQueue?.(failure, boundary, end);
      frame.await?.(failure, boundary, end);
      frame.submit?.(failure, boundary, end);
      frame.prepare?.(failure, boundary, end);
      frame.delegate(failure, boundary, end);
      outer(failure, undefined, end);
      recordContractLoadOwnership(
        frame.modelEntries,
        frame.driverDispatches,
        frame.transactional,
        frame.detailed
          ? {
              pgQueries: frame.pgQueries,
              pgSettlements: frame.pgSettlements,
              ...(frame.publicBoundaries
                ? {
                    publicBoundariesEnabled: true,
                    driverReturns: frame.driverReturns,
                    pgReturns: frame.pgReturns,
                    modelResumes: frame.modelResumes,
                    modelResumeObserved: frame.modelResumeObserved,
                  }
                : {}),
            }
          : undefined,
      );
    }
  });
}

/** Public query extension entry, not a compiler-only or first-model-compilation claim. */
export function markContractLoadModelEntry(
  model: string | undefined,
  operation: string,
  detailed = false,
  publicBoundaries = false,
): void {
  const frame = loads.getStore();
  if (!frame || frame.completed || model !== 'Contract' || operation !== 'findFirst') return;
  frame.modelEntries++;
  if (frame.modelEntries !== 1) return;
  const boundary = captureDataPathBoundary();
  frame.detailed = detailed;
  frame.publicBoundaries = detailed && publicBoundaries;
  if (detailed)
    frame.submit = beginDataPathPhase('contract-load-orm-submit', { processCpu: true, startBoundary: boundary });
  frame.prepare = beginDataPathPhase('contract-load-orm-prepare', { processCpu: true, startBoundary: boundary });
  frame.delegate(undefined, 'MODEL_EXTENSION_ENTERED', boundary);
}

/** Capture the existing extension wrapper's await continuation; never consume query(args) twice. */
export function captureContractLoadModelResume(
  model: string | undefined,
  operation: string,
): ((error?: unknown) => void) | undefined {
  const frame = loads.getStore();
  if (!frame?.publicBoundaries || frame.completed || model !== 'Contract' || operation !== 'findFirst')
    return undefined;
  return bindDataPathObservation((error) => {
    if (frame.completed) return;
    frame.modelResumes++;
    frame.modelResumeObserved = true;
    if (frame.modelResumes !== 1 || !frame.resultToModel) return;
    const boundary = captureDataPathBoundary();
    frame.resultAfterModel = beginDataPathPhase('contract-load-result-after-model', {
      processCpu: true,
      startBoundary: boundary,
    });
    frame.resultToModel(error, error === undefined ? 'MODEL_EXTENSION_RESUMED' : 'OPERATION_FAILED', boundary);
  });
}

/** Synchronous public query(args) return; preserve the original value/Promise and exception. */
export function observeContractLoadSubmission<T>(work: () => T): T {
  const frame = loads.getStore();
  if (!frame?.detailed || frame.completed) return work();
  try {
    const result = work();
    const returned = captureDataPathBoundary();
    frame.await = beginDataPathPhase('contract-load-orm-await', { processCpu: true, startBoundary: returned });
    frame.awaitQueue = beginDataPathPhase('contract-load-await-queue', { processCpu: true, startBoundary: returned });
    // One observation-only checkpoint. It neither awaits nor replaces the original Promise.
    queueMicrotask(
      bindDataPathObservation(() => {
        if (frame.completed || frame.driverDispatches !== 0) return;
        const checkpoint = captureDataPathBoundary();
        frame.awaitAfterQueue = beginDataPathPhase('contract-load-await-after-queue', {
          processCpu: true,
          startBoundary: checkpoint,
        });
        frame.awaitQueue?.(undefined, 'MICROTASK_CHECKPOINT', checkpoint);
      }),
    );
    frame.submit?.(undefined, 'CALL_RETURNED', returned);
    return result;
  } catch (error) {
    frame.submit?.(error ?? new Error('CONTRACT_SUBMISSION_FAILED'), 'OPERATION_FAILED');
    throw error;
  }
}

/** Called only by the leased pg port while its owning Contract adapter query is active. */
export interface ContractPgObservation {
  (error?: unknown): void;
  returned?: () => void;
}
export function beginContractLoadPgQuery(): ContractPgObservation | undefined {
  const frame = loads.getStore();
  if (!frame?.detailed || frame.completed || !frame.beforePg) return undefined;
  frame.pgQueries++;
  if (frame.pgQueries !== 1) return undefined;
  const entered = captureDataPathBoundary();
  if (frame.publicBoundaries)
    frame.pgSubmit = beginDataPathPhase('contract-load-pg-submit', { processCpu: true, startBoundary: entered });
  frame.pg = beginDataPathPhase('contract-load-driver-pg', { processCpu: true, startBoundary: entered });
  frame.beforePg(undefined, 'PG_DISPATCH', entered);
  const finish: ContractPgObservation = bindDataPathObservation((error) => {
    if (frame.completed) return;
    frame.pgSettlements++;
    if (frame.pgSettlements !== 1) return;
    const settled = captureDataPathBoundary();
    frame.afterPg = beginDataPathPhase('contract-load-driver-after-pg', { processCpu: true, startBoundary: settled });
    frame.pgAwait?.(error, error === undefined ? 'PG_SETTLED' : 'OPERATION_FAILED', settled);
    frame.pgSubmit?.(error, error === undefined ? 'PG_SETTLED' : 'OPERATION_FAILED', settled);
    frame.pg?.(error, error === undefined ? 'PG_SETTLED' : 'OPERATION_FAILED', settled);
  });
  if (frame.publicBoundaries)
    finish.returned = bindDataPathObservation(() => {
      if (frame.completed) return;
      frame.pgReturns++;
      // A synchronous callback may have already settled. Preserve it; do not fabricate a zero await.
      if (frame.pgReturns !== 1 || frame.pgSettlements !== 0) return;
      const returned = captureDataPathBoundary();
      frame.pgAwait = beginDataPathPhase('contract-load-pg-await', { processCpu: true, startBoundary: returned });
      frame.pgSubmit?.(undefined, 'PG_CALL_RETURNED', returned);
    });
  return finish;
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
    frame.awaitQueue?.(undefined, 'DRIVER_DISPATCH', dispatch);
    frame.awaitAfterQueue?.(undefined, 'DRIVER_DISPATCH', dispatch);
    frame.await?.(undefined, 'DRIVER_DISPATCH', dispatch);
  }
  frame.prepare?.(undefined, 'DRIVER_DISPATCH', dispatch);
  if (frame.publicBoundaries)
    frame.driverSubmit = beginDataPathPhase('contract-load-driver-submit', {
      processCpu: true,
      startBoundary: dispatch,
    });
  return (async () => {
    let failure: unknown;
    try {
      const pending = work();
      if (frame.publicBoundaries) {
        const returned = captureDataPathBoundary();
        frame.driverReturns++;
        frame.driverAwait = beginDataPathPhase('contract-load-driver-await', {
          processCpu: true,
          startBoundary: returned,
        });
        frame.driverSubmit?.(undefined, 'ADAPTER_CALL_RETURNED', returned);
      }
      return await pending;
    } catch (error) {
      failure = error ?? new Error('CONTRACT_QUERY_FAILED');
      throw error;
    } finally {
      const settled = captureDataPathBoundary();
      frame.afterPg?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.pgAwait?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.pgSubmit?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.pg?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.beforePg?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.driverAwait?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      frame.driverSubmit?.(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
      if (frame.publicBoundaries)
        frame.resultToModel = beginDataPathPhase('contract-load-result-to-model', {
          processCpu: true,
          startBoundary: settled,
        });
      frame.result = beginDataPathPhase('contract-load-result', { processCpu: true, startBoundary: settled });
      query(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
    }
  })();
}
