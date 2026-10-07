import { AsyncLocalStorage } from 'node:async_hooks';
import { beginDataPathPhase, claimFirstDataPathPhase, type PreparationBoundary } from '@fdp/observability';
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
function finishSubmission(frame: Preparation, boundary: PreparationBoundary, error?: unknown): void {
  if (!frame.submit || frame.awaitDispatch) return;
  frame.submit(error, boundary);
  frame.awaitDispatch = beginDataPathPhase('db-client-await-dispatch', { processCpu: true });
}
function finishPreparation(frame: Preparation, boundary: PreparationBoundary, error?: unknown): void {
  if (frame.completed) return;
  frame.completed = true;
  finishSubmission(frame, boundary, error);
  frame.awaitDispatch?.(error, boundary);
  frame.afterAdapter?.(error, boundary);
  frame.finish(error, boundary);
}
/** First public ORM operation in a trace, measured until its own root driver dispatch or settlement. */
export async function observeDatabaseClientPreparation<T>(work: () => Promise<T>): Promise<T> {
  const finish = claimFirstDataPathPhase('db-client-prepare', { processCpu: true });
  if (!finish) return preparation.run(undefined, async () => await work());
  const frame: Preparation = {
    finish,
    completed: false,
    submit: beginDataPathPhase('db-client-submit', { processCpu: true }),
  };
  return preparation.run(frame, async () => {
    try {
      const pending = work();
      finishSubmission(frame, 'CALL_RETURNED');
      const value = await pending;
      finishPreparation(frame, 'OPERATION_SETTLED');
      return value;
    } catch (error) {
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
