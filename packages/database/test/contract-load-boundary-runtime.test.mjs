import { test } from 'vitest';
import assert from 'node:assert/strict';
import process from 'node:process';
import { withDataPathTrace } from '@fdp/observability';
import {
  observeContractLoad,
  markContractLoadModelEntry,
  observeContractLoadDriver,
} from '../src/contract-load-observation.js';
import { validateContractLoadSplit } from '../../../scripts/qa09-contract-load-proof.mjs';

for (const overhead of [17, 20])
  test(`contract partition covers ${overhead}ms boundary CPU capture and logging overhead`, async () => {
    let tick = 0,
      user = 0;
    const rows = [],
      RealDate = globalThis.Date,
      realCpu = process.cpuUsage;
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [tick]));
      }
    };
    process.cpuUsage = () => {
      tick += overhead;
      user += overhead * 1000;
      return { user, system: 0 };
    };
    try {
      await withDataPathTrace(
        { lambdaRequestId: 'lambda', gatewayRequestId: 'gateway', operationId: 'updateContract' },
        () =>
          observeContractLoad(async () => {
            tick += 10;
            markContractLoadModelEntry('Contract', 'findFirst');
            await Promise.resolve();
            tick += 30;
            await observeContractLoadDriver(async () => {
              tick += 13;
              return 1;
            }, true);
            tick += 7;
          }),
        (r) => {
          rows.push(r);
          tick += 20;
        },
        () => tick,
      );
      const result = validateContractLoadSplit(
        rows.filter((r) => r.event === 'data-path.phase.completed'),
        rows.filter((r) => r.event === 'data-path.contract-load.ownership'),
        true,
      );
      assert.equal(result.gate, 'PASS');
      assert.equal(result.loadMs, result.delegateMs + result.ormPrepareMs + result.driverQueryMs + result.resultMs);
    } finally {
      globalThis.Date = RealDate;
      process.cpuUsage = realCpu;
    }
  });
