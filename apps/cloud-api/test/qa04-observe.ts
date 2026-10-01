import { appendFileSync } from 'node:fs';
import { vi } from 'vitest';

// Test-only interception preserves every production factory, dependency, input and output.
// Only the dedicated QA-04 config loads this observer; the normal test run is unaffected.
vi.mock('../src/index.js', async (importOriginal) => {
  const original = await importOriginal<Record<string, (...args: any[]) => any>>();
  // @ts-expect-error Shared executable JS manifest has no TypeScript declaration.
  const { QA04_FACTORIES } = await import('../../../scripts/qa04-manifest.mjs');
  const wrapped = { ...original };
  for (const [factory, area] of Object.entries(QA04_FACTORIES)) {
    if (typeof original[factory] !== 'function') throw new Error(`Missing QA04 factory ${factory}`);
    wrapped[factory] = (...args: any[]) => {
      const handlers = original[factory]!(...args);
      const observe =
        (handler: (...params: any[]) => any, method: string) =>
        async (...params: any[]) => {
          const response = await handler(...params);
          const req = params[0];
          if (process.env.QA04_TRACE)
            appendFileSync(
              process.env.QA04_TRACE,
              JSON.stringify({
                kind: 'handler',
                source: 'REAL_HANDLER',
                area,
                method,
                status: response.status,
                roles: req?.actor?.roles ?? [],
                customerId: req?.actor?.customerId ?? null,
                requestId: req?.requestId ?? null,
                errorCode: response.body?.error?.code ?? null,
                replayed: response.body?.data?.replayed === true,
                ifMatch: req?.headers?.['If-Match'] ?? req?.headers?.['if-match'] ?? null,
              }) + '\n',
            );
          return response;
        };
      return typeof handlers === 'function'
        ? observe(handlers, 'handle')
        : Object.fromEntries(
            Object.entries(handlers).map(([method, handler]) => [
              method,
              observe(handler as (...params: any[]) => any, method),
            ]),
          );
    };
  }
  return wrapped;
});
