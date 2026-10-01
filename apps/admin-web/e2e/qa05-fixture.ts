import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { expect, test as base } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';

interface Qa05Fixture {
  prefix: string;
  proof: Record<string, unknown>;
  newPage(): Promise<Page>;
}
export const test = base.extend<{ qa05: Qa05Fixture }>({
  qa05: [
    async ({ browser, context }, use, info) => {
      const prefix = `QA05-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
      const proof: Record<string, unknown> = {};
      const contexts: BrowserContext[] = [];
      const unhandled: string[] = [];
      const responses: { path: string; method: string; status: number }[] = [];
      async function guard(current: BrowserContext) {
        contexts.push(current);
        current.on('response', (response) => {
          const url = new URL(response.url());
          if (url.pathname.startsWith('/api/v1/'))
            responses.push({ path: url.pathname, method: response.request().method(), status: response.status() });
        });
        await current.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.origin === 'http://127.0.0.1:4173' && !url.pathname.startsWith('/api/v1/')) return route.continue();
          unhandled.push(`${route.request().method()} ${url.hostname}${url.pathname}`);
          await route.abort('blockedbyclient');
        });
      }
      await guard(context);
      try {
        await use({
          prefix,
          proof,
          newPage: async () => {
            const page = await browser.newPage();
            await guard(page.context());
            return page;
          },
        });
      } finally {
        await Promise.all(contexts.map((current) => current.close()));
      }
      expect(unhandled, 'Unmocked API or external request is blocked').toEqual([]);
      if (process.env.QA05_TRACE)
        appendFileSync(
          process.env.QA05_TRACE,
          JSON.stringify({
            title: info.title,
            testId: info.testId,
            repeat: info.repeatEachIndex,
            workerIndex: info.workerIndex,
            parallelIndex: info.parallelIndex,
            retry: info.retry,
            prefix,
            status: info.status,
            cleanup: 'PASS',
            unhandled,
            responses,
            proof,
          }) + '\n',
        );
    },
    { auto: true },
  ],
});
