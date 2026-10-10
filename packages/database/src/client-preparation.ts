import { AsyncLocalStorage } from 'node:async_hooks';
import {
  beginDataPathPhase,
  captureDataPathBoundary,
  claimFirstDataPathBoundary,
  type DataPathBoundary,
  type PreparationBoundary,
} from '@fdp/observability';
type Finish = ReturnType<typeof beginDataPathPhase>;
interface Preparation {
  finish: Finish;
  afterAdapter?: Finish;
  completed: boolean;
  engine?: boolean;
  submit?: Finish;
  awaitDispatch?: Finish;
}
const preparation = new AsyncLocalStorage<Preparation | undefined>();
function finishSubmission(
  frame: Preparation,
  boundary: PreparationBoundary,
  error?: unknown,
  end?: DataPathBoundary,
): void {
  if (!frame.submit || frame.awaitDispatch) return;
  const split = end ?? captureDataPathBoundary();
  frame.awaitDispatch = beginDataPathPhase('db-client-await-dispatch', { processCpu: true, startBoundary: split });
  frame.submit(error, boundary, split);
}
function finishPreparation(frame: Preparation, boundary: PreparationBoundary, error?: unknown): void {
  if (frame.completed) return;
  frame.completed = true;
  const end = frame.engine ? undefined : captureDataPathBoundary();
  finishSubmission(frame, boundary, error, end);
  frame.awaitDispatch?.(error, boundary, end);
  frame.afterAdapter?.(error, boundary, end);
  frame.finish(error, boundary, end);
}
function notifySettlement(settled: ((error?: unknown) => void) | undefined, error?: unknown): void {
  try {
    settled?.(error);
  } catch {
    /* Observation cannot replace the original result or exception. */
  }
}
/** First public ORM operation in a trace, measured until its own root driver dispatch or settlement. */
export async function observeDatabaseClientPreparation<T>(
  work: () => Promise<T>,
  settled?: (error?: unknown) => void,
): Promise<T> {
  const start = claimFirstDataPathBoundary('db-client-prepare');
  if (!start)
    return preparation.run(undefined, async () => {
      try {
        const value = await work();
        notifySettlement(settled);
        return value;
      } catch (error) {
        notifySettlement(settled, error ?? new Error('CLIENT_PREPARATION_FAILED'));
        throw error;
      }
    });
  const finish = beginDataPathPhase('db-client-prepare', { processCpu: true, startBoundary: start });
  const setup = beginDataPathPhase('db-client-observer-setup', { processCpu: true, startBoundary: start });
  const frame: Preparation = {
    finish,
    completed: false,
  };
  const submitStart = captureDataPathBoundary();
  frame.submit = beginDataPathPhase('db-client-submit', { processCpu: true, startBoundary: submitStart });
  setup(undefined, 'CALL_RETURNED', submitStart);
  return preparation.run(frame, async () => {
    try {
      const pending = work();
      finishSubmission(frame, 'CALL_RETURNED');
      const value = await pending;
      notifySettlement(settled);
      finishPreparation(frame, 'OPERATION_SETTLED');
      return value;
    } catch (error) {
      notifySettlement(settled, error ?? new Error('CLIENT_PREPARATION_FAILED'));
      finishPreparation(frame, 'OPERATION_FAILED', error ?? new Error('CLIENT_PREPARATION_FAILED'));
      throw error;
    }
  });
}
/** Adapter creation does not open pg connections; this suffix includes compiler/planning and scheduling. */
export function markDatabaseAdapterReady(): void {
  const frame = preparation.getStore();
  if (frame && !frame.completed && !frame.afterAdapter)
    frame.afterAdapter = beginDataPathPhase(frame.engine ? 'db-engine-after-adapter' : 'db-client-after-adapter', {
      processCpu: frame.engine === true,
    });
}
export function markDatabaseDriverDispatch(): void {
  const frame = preparation.getStore();
  if (frame) finishPreparation(frame, 'DRIVER_DISPATCH');
}

/** Public $connect diagnostics only; keeps the later query's driver-dispatch boundary independent. */
export async function observeDatabaseEnginePreparation(work: () => Promise<void>): Promise<void> {
  const frame: Preparation = {
    finish: beginDataPathPhase('db-engine-prepare', { processCpu: true }),
    completed: false,
    engine: true,
  };
  return preparation.run(frame, async () => {
    try {
      await work();
      finishPreparation(frame, 'OPERATION_SETTLED');
    } catch (error) {
      finishPreparation(frame, 'OPERATION_FAILED', error ?? new Error('ENGINE_PREPARATION_FAILED'));
      throw error;
    }
  });
}
