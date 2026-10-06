import { randomUUID } from 'node:crypto';
import { assertBusinessContext } from './qa09-business-target.mjs';
/** Separate contracts preserve the existing three-round race and allow six real concurrent requests. */
export async function runCold409Sampling(ctx, { batches = 2 } = {}) {
  assertBusinessContext(ctx);
  if (![1, 2].includes(batches)) throw Error('COLD_SAMPLING_BUDGET_REQUIRED');
  if (ctx.businessReceipt.remaining?.gate !== 'PASS') throw Error('BASELINE_RACE_REQUIRED');
  const r = {
    scope: 'OWN_DRAFT_COLD409_BOUNDED_SAMPLING',
    gate: 'RUNNING',
    coldGate: 'NOT_EVALUATED',
    maxConcurrency: 6,
    maxPatchRequests: 12,
    configuredBatches: batches,
    attempts: [],
    contracts: [],
    batches: [],
    audit: [],
    checks: [],
    fullQa09Accepted: false,
    p95Accepted: false,
  };
  ctx.businessReceipt.cold409Sampling = r;
  const proof = (id, ok) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
    ctx.save();
    if (!ok) throw Error('COLD_SAMPLING_ASSERTION_FAILED');
  };
  const grace = async () => {
    r.unknownWriteGraceMs = 35000;
    ctx.save();
    await (ctx.waitForWriteQuiescence ?? (() => new Promise((resolve) => setTimeout(resolve, 35000))))();
  };
  try {
    for (let batch = 1; batch <= batches; batch++) {
      const contracts = [];
      for (let index = 1; index <= 3; index++) {
        const name = `${ctx.prefix}-cold-${batch}-${index}`,
          now = Date.now();
        const contract = (
          await ctx.api(`cold:${batch}:${index}:create`, 'PlatformSuperAdmin', 'POST', '/api/v1/admin/contracts', 201, {
            contractNumber: name,
            name,
            customerId: ctx.customers[0].id,
            startAt: new Date(now - 86400000).toISOString(),
            endAt: new Date(now + 86400000 * 30).toISOString(),
          })
        ).data;
        proof(
          `cold:${batch}:${index}:owned-draft`,
          /^[a-f0-9-]{36}$/.test(contract.contractId) &&
            contract.customerId === ctx.customers[0].id &&
            contract.status === 'DRAFT' &&
            contract.version === 1 &&
            contract.name === name,
        );
        contracts.push({ ...contract, batch, index });
        r.contracts.push({ ...contract, batch, index });
        ctx.save();
      }
      const attempts = contracts.flatMap((contract) =>
        ['a', 'b'].map((side) => ({
          id: `cold:${batch}:${contract.index}:${side}`,
          batch,
          index: contract.index,
          side,
          contractId: contract.contractId,
          clientRequestId: randomUUID(),
          method: 'PATCH',
          path: '/api/v1/admin/contracts/' + contract.contractId,
          ifMatch: contract.version,
          name: `${ctx.prefix}-cold-${batch}-${contract.index}-${side}`,
          state: 'PREPARED',
        })),
      );
      r.attempts.push(...attempts);
      ctx.save();
      // One bounded barrier, no retries; all siblings settle before readback/cleanup.
      const outcomes = await Promise.allSettled(
        attempts.map(async (a) => {
          a.state = 'DISPATCHED';
          a.startedAt = new Date().toISOString();
          ctx.save();
          try {
            await ctx.api(
              a.id,
              'PlatformSuperAdmin',
              'PATCH',
              a.path,
              [200, 409],
              { name: a.name, reason: ctx.prefix },
              { 'If-Match': String(a.ifMatch), 'x-amzn-RequestId': a.clientRequestId },
            );
            a.state = 'SETTLED';
          } catch (e) {
            a.state = 'REJECTED';
            throw e;
          } finally {
            a.completedAt = new Date().toISOString();
            const observed = ctx.businessReceipt.checks.find((x) => x.id === a.id);
            if (observed) a.observation = { ...observed };
            ctx.save();
          }
        }),
      );
      r.batches.push({ batch, settled: outcomes.map((x) => x.status) });
      ctx.save();
      if (outcomes.some((x) => x.status === 'rejected')) await grace();
      for (const c of contracts) {
        const pair = attempts.filter((a) => a.contractId === c.contractId);
        const after = (await ctx.api(`cold:${batch}:${c.index}:after`, 'PlatformSuperAdmin', 'GET', pair[0].path, 200))
          .data;
        const winner = pair.find((a) => a.observation?.status === 200),
          loser = pair.find((a) => a.observation?.status === 409);
        proof(
          `cold:${batch}:${c.index}:one-winner`,
          outcomes.every((x) => x.status === 'fulfilled') &&
            winner &&
            loser &&
            loser.observation.errorCode === 'VERSION_CONFLICT',
        );
        proof(
          `cold:${batch}:${c.index}:version-name`,
          after.contractId === c.contractId &&
            after.customerId === c.customerId &&
            after.version === 2 &&
            after.name === winner.name &&
            after.status === 'DRAFT',
        );
        proof(
          `cold:${batch}:${c.index}:dispatch-overlap`,
          pair.every((a, i) => Date.parse(a.startedAt) <= Date.parse(pair[1 - i].completedAt)),
        );
        proof(
          `cold:${batch}:${c.index}:request-ids`,
          pair.every((a) => a.observation.gatewayRequestId === a.clientRequestId),
        );
        const list = await ctx.api(
          `cold:audit:${batch}:${c.index}:list`,
          'PlatformSuperAdmin',
          'GET',
          `/api/v1/admin/audit-logs?objectType=contract&objectId=${c.contractId}&action=contract.update&limit=100`,
          200,
        );
        proof(`cold:${batch}:${c.index}:audit-count`, !list.meta?.nextCursor && list.data.length === 2);
        for (const entry of list.data) {
          proof(
            `cold:audit:${entry.auditId}:list-owned`,
            entry.objectId === c.contractId && entry.objectType === 'contract',
          );
          const detail = (
            await ctx.api(
              `cold:audit:${batch}:${c.index}:${entry.auditId}`,
              'PlatformSuperAdmin',
              'GET',
              '/api/v1/admin/audit-logs/' + entry.auditId,
              200,
            )
          ).data;
          proof(
            `cold:audit:${entry.auditId}:owned`,
            detail.auditId === entry.auditId &&
              detail.objectId === c.contractId &&
              detail.objectType === 'contract' &&
              detail.reason === ctx.prefix,
          );
          r.audit.push({
            auditId: detail.auditId,
            contractId: c.contractId,
            requestId: detail.requestId,
            result: detail.result,
            beforeVersion: detail.beforeValue?.version,
            afterVersion: detail.afterValue?.version,
          });
          ctx.save();
        }
        for (const a of pair) {
          const found = r.audit.filter((x) => x.requestId === a.clientRequestId && x.contractId === c.contractId);
          proof(
            a.id + ':audit-binding',
            found.length === 1 &&
              found[0].result === (a === winner ? 'SUCCESS' : 'FAILURE') &&
              found[0].beforeVersion === 1 &&
              (a !== winner || found[0].afterVersion === 2),
          );
        }
        r.contracts.find((x) => x.contractId === c.contractId).readback = {
          name: after.name,
          version: after.version,
          status: after.status,
        };
        ctx.save();
      }
    }
    r.gate = 'PASS';
  } catch (e) {
    // Also cover unknown POST outcomes; quiesce before outer fixture cleanup.
    if (r.unknownWriteGraceMs === undefined) await grace();
    r.gate = 'FAIL';
    r.failureCode = /^[\w:-]{1,150}$/.test(e.message) ? e.message : 'COLD_SAMPLING_FAILED';
  }
  ctx.save();
  return r;
}
