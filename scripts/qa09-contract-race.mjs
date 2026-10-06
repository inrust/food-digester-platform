import { randomUUID } from 'node:crypto';
import { assertBusinessContext } from './qa09-business-target.mjs';

/** Both requests must settle before readback or fixture cleanup; never retry an unknown write. */
export async function runContractRaceTarget(ctx, { historical } = {}) {
  assertBusinessContext(ctx);
  const r = {
    scope: 'OWN_DRAFT_CONTRACT_THREE_CONCURRENT_IF_MATCH_ROUNDS',
    gate: 'RUNNING',
    fullQa09Accepted: false,
    rounds: [],
    attempts: [],
    checks: [],
  };
  ctx.businessReceipt.remaining = r;
  const proof = (id, ok) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
    ctx.save();
    if (!ok) throw Error('CONTRACT_RACE_ASSERTION_FAILED');
  };
  try {
    if (historical) {
      if (
        historical.prefix !== 'qa09-0ed30921f63c8541' ||
        historical.contractId !== '7d95a76b-1b79-42c0-9f64-2c98a9297898' ||
        historical.sourceReceiptSha256 !== '59473f9dbb9288fe2b2933f7bb08c6d187553ac2bf313ccc38ea47b711737e5f'
      )
        throw Error('HISTORICAL_CONTRACT_SCOPE_FORBIDDEN');
      r.historical = { ...historical, audit: [], gate: 'PARTIAL', clientSiblingReceipt: 'MISSING' };
      const old = await ctx.api(
        'race:historical-audit-list',
        'PlatformSuperAdmin',
        'GET',
        `/api/v1/admin/audit-logs?objectType=contract&objectId=${historical.contractId}&action=contract.update&limit=100`,
        200,
      );
      for (const row of old.data) {
        if (row.objectType !== 'contract' || row.objectId !== historical.contractId)
          throw Error('HISTORICAL_AUDIT_SCOPE_DRIFT');
        const detail = (
          await ctx.api(
            'race:historical-audit:' + row.auditId,
            'PlatformSuperAdmin',
            'GET',
            '/api/v1/admin/audit-logs/' + row.auditId,
            200,
          )
        ).data;
        if (detail.reason !== historical.prefix) throw Error('HISTORICAL_AUDIT_REASON_DRIFT');
        r.historical.audit.push({
          auditId: detail.auditId,
          result: detail.result,
          requestId: detail.requestId,
          createdAt: detail.createdAt,
          beforeVersion: detail.beforeValue?.version,
          afterVersion: detail.afterValue?.version,
        });
      }
      r.historical.paginationComplete = !old.meta?.nextCursor;
      ctx.save();
    }
    const now = Date.now();
    let contract = (
      await ctx.api('race:create', 'PlatformSuperAdmin', 'POST', '/api/v1/admin/contracts', 201, {
        contractNumber: ctx.prefix + '-race',
        name: ctx.prefix + '-race',
        customerId: ctx.customers[0].id,
        startAt: new Date(now - 86400000).toISOString(),
        endAt: new Date(now + 86400000 * 30).toISOString(),
      })
    ).data;
    proof('own-draft-contract', contract.customerId === ctx.customers[0].id && contract.status === 'DRAFT');
    r.contractId = contract.contractId;
    const path = '/api/v1/admin/contracts/' + r.contractId;
    for (let round = 1; round <= 3; round++) {
      const before = (await ctx.api(`race:${round}:before`, 'PlatformSuperAdmin', 'GET', path, 200)).data;
      proof(`round-${round}:initial-version`, before.version === contract.version && before.status === 'DRAFT');
      const attempts = ['a', 'b'].map((side) => ({
        id: `race:${round}:${side}`,
        round,
        side,
        clientRequestId: randomUUID(),
        path,
        method: 'PATCH',
        ifMatch: before.version,
        name: `${ctx.prefix}-race-${round}-${side}`,
        state: 'PREPARED',
      }));
      r.attempts.push(...attempts);
      ctx.save();
      const outcomes = await Promise.allSettled(
        attempts.map(async (attempt) => {
          attempt.state = 'DISPATCHED';
          attempt.startedAt = new Date().toISOString();
          ctx.save();
          try {
            const value = await ctx.api(
              attempt.id,
              'PlatformSuperAdmin',
              'PATCH',
              path,
              [200, 409],
              { name: attempt.name, reason: ctx.prefix },
              { 'If-Match': String(before.version), 'x-amzn-RequestId': attempt.clientRequestId },
            );
            attempt.state = 'SETTLED';
            return value;
          } catch (e) {
            attempt.state = 'REJECTED';
            throw e;
          } finally {
            attempt.completedAt = new Date().toISOString();
            const observed = ctx.businessReceipt.checks.find((x) => x.id === attempt.id);
            if (observed) attempt.observation = { ...observed };
            ctx.save();
          }
        }),
      );
      r.rounds.push({ round, settled: outcomes.map((x) => x.status), beforeVersion: before.version });
      ctx.save();
      if (outcomes.some((x) => x.status === 'rejected')) {
        // The deployed API has a 30s Lambda timeout; a client timeout does not stop its write.
        r.unknownWriteGraceMs = 35000;
        ctx.save();
        await (ctx.waitForWriteQuiescence ?? (() => new Promise((resolve) => setTimeout(resolve, 35000))))();
      }
      // A readback can explain an unknown outcome, but cannot promote missing HTTP evidence to PASS.
      contract = (await ctx.api(`race:${round}:after`, 'PlatformSuperAdmin', 'GET', path, 200)).data;
      r.rounds.at(-1).readback = { version: contract.version, name: contract.name, status: contract.status };
      ctx.save();
      proof(
        `round-${round}:both-http-receipts`,
        outcomes.every((x) => x.status === 'fulfilled'),
      );
      proof(
        `round-${round}:overlapping-dispatch`,
        attempts.every((x, i) => Date.parse(x.startedAt) <= Date.parse(attempts[1 - i].completedAt)),
      );
      proof(
        `round-${round}:one-winner-one-conflict`,
        attempts
          .map((x) => x.observation?.status)
          .sort()
          .join(',') === '200,409',
      );
      const winner = attempts.find((x) => x.observation?.status === 200);
      const loser = attempts.find((x) => x.observation?.status === 409);
      proof(
        `round-${round}:version-and-winning-name`,
        contract.version === before.version + 1 && contract.name === winner.name && contract.status === 'DRAFT',
      );
      proof(`round-${round}:explicit-version-conflict`, loser.observation.errorCode === 'VERSION_CONFLICT');
      proof(
        `round-${round}:gateway-honored-distinct-ids`,
        attempts.every((x) => x.observation.gatewayRequestId === x.clientRequestId),
      );
    }
    const list = await ctx.api(
      'race:audit-list',
      'PlatformSuperAdmin',
      'GET',
      `/api/v1/admin/audit-logs?objectType=contract&objectId=${r.contractId}&action=contract.update&limit=100`,
      200,
    );
    proof(
      'audit-no-pagination-or-missing-successes',
      !list.meta?.nextCursor && list.data.filter((x) => x.result === 'SUCCESS').length === 3,
    );
    r.audit = [];
    for (const row of list.data) {
      proof('audit-own-object-' + row.auditId, row.objectType === 'contract' && row.objectId === r.contractId);
      const detail = (
        await ctx.api(
          'race:audit-detail:' + row.auditId,
          'PlatformSuperAdmin',
          'GET',
          '/api/v1/admin/audit-logs/' + row.auditId,
          200,
        )
      ).data;
      r.audit.push({
        id: detail.auditId,
        result: detail.result,
        requestId: detail.requestId,
        beforeVersion: detail.beforeValue?.version,
        afterVersion: detail.afterValue?.version,
      });
    }
    proof(
      'audit-exact-success-request-ids',
      r.attempts
        .filter((x) => x.observation?.status === 200)
        .every((x) => r.audit.filter((a) => a.result === 'SUCCESS' && a.requestId === x.clientRequestId).length === 1),
    );
    proof(
      'audit-success-versions',
      r.attempts
        .filter((x) => x.observation?.status === 200)
        .every((x) =>
          r.audit.some(
            (a) =>
              a.result === 'SUCCESS' &&
              a.requestId === x.clientRequestId &&
              a.beforeVersion === x.ifMatch &&
              a.afterVersion === x.ifMatch + 1,
          ),
        ),
    );
    proof(
      'audit-conflicts-never-success',
      r.attempts
        .filter((x) => x.observation?.status === 409)
        .every((x) => !r.audit.some((a) => a.result === 'SUCCESS' && a.requestId === x.clientRequestId)),
    );
    r.finalContract = {
      contractId: contract.contractId,
      customerId: contract.customerId,
      name: contract.name,
      version: contract.version,
      status: contract.status,
    };
    r.gate = 'PASS';
  } catch (e) {
    r.gate = 'FAIL';
    r.failureCode = /^[\w:-]{1,150}$/.test(e.code ?? e.message) ? (e.code ?? e.message) : 'CONTRACT_RACE_FAILED';
  }
  ctx.save();
  return r;
}
