import { AsyncLocalStorage } from 'node:async_hooks';
import { beginDataPathPhase, captureDataPathBoundary, recordContractLoadOwnership } from '@fdp/observability';

type Finish = ReturnType<typeof beginDataPathPhase>;
interface LoadScope {
  delegate: Finish;
  prepare?: Finish;
  result?: Finish;
  modelEntries: number;
  driverDispatches: number;
  transactional: boolean;
  completed: boolean;
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
      frame.prepare?.(failure, boundary, end);
      frame.delegate(failure, boundary, end);
      outer(failure, undefined, end);
      recordContractLoadOwnership(frame.modelEntries, frame.driverDispatches, frame.transactional);
    }
  });
}

/** Public query extension entry, not a compiler-only or first-model-compilation claim. */
export function markContractLoadModelEntry(model: string | undefined, operation: string): void {
  const frame = loads.getStore();
  if (!frame || frame.completed || model !== 'Contract' || operation !== 'findFirst') return;
  frame.modelEntries++;
  if (frame.modelEntries !== 1) return;
  const boundary = captureDataPathBoundary();
  frame.prepare = beginDataPathPhase('contract-load-orm-prepare', { processCpu: true, startBoundary: boundary });
  frame.delegate(undefined, 'MODEL_EXTENSION_ENTERED', boundary);
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
      frame.result = beginDataPathPhase('contract-load-result', { processCpu: true, startBoundary: settled });
      query(failure, failure === undefined ? 'OPERATION_SETTLED' : 'OPERATION_FAILED', settled);
    }
  })();
}
