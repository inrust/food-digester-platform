import { Pool, type PoolClient, type PoolConfig } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { beginFirstDataPathPhase } from '@fdp/observability';

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  release: (error?: Error | boolean) => void,
) => void;

/** Measures checkout through callback/promise settlement, including queueing and new TCP/TLS connections. */
export class ObservedPgPool extends Pool {
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
  constructor(private readonly poolConfig: PoolConfig) {
    super(poolConfig);
  }
  override async connect(): Promise<Awaited<ReturnType<PrismaPg['connect']>>> {
    const adapter = await new PrismaPg(new ObservedPgPool(this.poolConfig), { disposeExternalPool: true }).connect();
    const query = adapter.queryRaw.bind(adapter);
    const execute = adapter.executeRaw.bind(adapter);
    const first = async <T>(work: () => Promise<T>): Promise<T> => {
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
    adapter.queryRaw = (q) => first(() => query(q));
    adapter.executeRaw = (q) => first(() => execute(q));
    return adapter;
  }
}
