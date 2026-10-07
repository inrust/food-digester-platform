import { beginDataPathPhase } from '@fdp/observability';

export interface OwnedPreconnectPool {
  prepareAuthenticatedConnection(): Promise<void>;
}

/** Admin-only opt-in port. Owns no pool: the actual adapter lends its current generation. */
export class AuthenticatedPreconnect {
  private pool: OwnedPreconnectPool | undefined;
  private generation = 0;
  private flight: Promise<void> | undefined;
  private startCheckout: (() => void) | undefined;

  adapterReady(pool: OwnedPreconnectPool): void {
    this.invalidate();
    this.pool = pool;
    this.startCheckout?.();
  }

  adapterDisposed(pool: OwnedPreconnectPool): void {
    if (this.pool === pool) {
      this.pool = undefined;
      this.invalidate();
    }
  }

  private invalidate(): void {
    this.generation++;
    if (!this.startCheckout) this.flight = undefined;
  }

  /** Both branches settle; engine error wins deterministically. No business query retry. */
  prepare(engine: () => Promise<void>): Promise<void> {
    if (this.flight) return this.flight;
    let checkout: Promise<void> | undefined;
    let ownedGeneration = this.generation;
    const start = () => {
      if (checkout || !this.pool) return;
      ownedGeneration = this.generation;
      const pool = this.pool;
      const finish = beginDataPathPhase('db-authenticated-preconnect');
      checkout = Promise.resolve()
        .then(() => pool.prepareAuthenticatedConnection())
        .then(
          () => finish(undefined, 'OPERATION_SETTLED'),
          (error) => {
            finish(error ?? new Error('PRECONNECT_FAILED'), 'OPERATION_FAILED');
            throw error;
          },
        );
      // Observe rejection immediately while the engine branch is still pending.
      void checkout.catch(() => {});
    };
    this.startCheckout = start;
    start();
    const run = async () => {
      const [engineResult] = await Promise.allSettled([Promise.resolve().then(engine)]);
      this.startCheckout = undefined;
      const [connectionResult] = await Promise.allSettled([
        checkout ?? Promise.reject(new Error('PRECONNECT_ADAPTER_NOT_READY')),
      ]);
      if (engineResult.status === 'rejected') throw engineResult.reason;
      if (connectionResult.status === 'rejected') throw connectionResult.reason;
      if (ownedGeneration !== this.generation || !this.pool) throw new Error('PRECONNECT_GENERATION_INVALIDATED');
    };
    const flight = run().catch((error) => {
      if (this.flight === flight) this.flight = undefined;
      throw error;
    });
    this.flight = flight;
    return flight;
  }
}
