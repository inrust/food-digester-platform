import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { markDatabaseAdapterReady, markDatabaseDriverDispatch } from './client-preparation.js';
import { beginFirstDataPathPhase } from '@fdp/observability';
import type { AuthenticatedPreconnect } from './authenticated-preconnect.js';
import { observeContractLoadDriver } from './contract-load-observation.js';

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (error?: Error | boolean) => void,
) => void;

/** Measures checkout through callback/promise settlement, including queueing and new TCP/TLS connections. */
export class ObservedPgPool extends Pool {
  /** Bypass first-business-checkout claiming; pg retains its original 5s checkout timeout. */
  async prepareAuthenticatedConnection(): Promise<void> {
    const client = await super.connect();
    client.release();
  }
  override connect(): Promise<PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<PoolClient> | void {
    const finish = beginFirstDataPathPhase('db-first-connection');
    try {
      if (callback)
        return super.connect((error, client, release) => {
          finish(error);
          callback(error, client, release);
        });
      return super.connect().then(
        (client) => {
          finish();
          return client;
        },
        (error) => {
          finish(error ?? new Error('CONNECTION_FAILED'));
          throw error;
        },
      );
    } catch (error) {
      finish(error ?? new Error('CONNECTION_FAILED'));
      throw error;
    }
  }
}

/** A new adapter owns each pool, preserving disconnect/reconnect ownership without warming connections. */
export class ObservedPrismaPg extends PrismaPg {
  constructor(
    private readonly poolConfig: PoolConfig,
    private readonly preconnect?: AuthenticatedPreconnect,
  ) {
    super(poolConfig);
  }
  override async connect(): Promise<Awaited<ReturnType<PrismaPg['connect']>>> {
    const ready = beginFirstDataPathPhase('db-adapter-connect');
    let adapter: Awaited<ReturnType<PrismaPg['connect']>>;
    const pool = new ObservedPgPool(this.poolConfig);
    try {
      adapter = await new PrismaPg(pool, { disposeExternalPool: true }).connect();
      this.preconnect?.adapterReady(pool);
      ready();
      markDatabaseAdapterReady();
    } catch (error) {
      ready(error ?? new Error('ADAPTER_PREPARATION_FAILED'));
      throw error;
    }
    const dispose = adapter.dispose.bind(adapter);
    adapter.dispose = async () => {
      this.preconnect?.adapterDisposed(pool);
      await dispose();
    };
    const query = adapter.queryRaw.bind(adapter);
    const execute = adapter.executeRaw.bind(adapter);
    const first = async <T>(work: () => Promise<T>): Promise<T> => {
      markDatabaseDriverDispatch();
      const finish = beginFirstDataPathPhase('db-first-query');
      try {
        const value = await work();
        finish();
        return value;
      } catch (error) {
        finish(error ?? new Error('QUERY_FAILED'));
        throw error;
      }
    };
    adapter.queryRaw = (q) => observeContractLoadDriver(() => first(() => query(q)), false);
    adapter.executeRaw = (q) => observeContractLoadDriver(() => first(() => execute(q)), false);
    const startTransaction = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (...args) => {
      const tx = await startTransaction(...args);
      const txQuery = tx.queryRaw.bind(tx),
        txExecute = tx.executeRaw.bind(tx);
      tx.queryRaw = (q) => observeContractLoadDriver(() => txQuery(q), true);
      tx.executeRaw = (q) => observeContractLoadDriver(() => txExecute(q), true);
      return tx;
    };
    return adapter;
  }
}
