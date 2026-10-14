import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
export const MUTATION_AUDIT_ACTIONS = {
  createLicense: 'license.create_draft',
  issueLicense: 'license.Draft_to_Issued',
  createCustomer: 'customer.create',
  updateCustomer: 'customer.update',
  deleteCustomer: 'customer.delete',
  deactivateCustomer: 'customer.deactivate',
  createSite: 'site.create',
  updateSite: 'site.update',
  deleteSite: 'site.delete',
  deactivateSite: 'site.deactivate',
  updateDeviceMetadata: 'device.metadata.update',
  assignDevice: 'device.assignment.assign',
  createReplayJob: 'replay.job.create',
  createConfiguration: 'configuration.create',
  createConfigurationVersion: 'configuration.create_version',
  publishConfigurationVersion: 'configuration.publish',
  createDeviceUser: 'device.user.create',
  updateDeviceUser: 'device.user.update',
  disableDeviceUser: 'device.user.disable',
  assignDeviceUser: 'device.user.assign',
  revokeDeviceUser: 'device.user.revoke',
  createConsumableRequest: 'consumable.request.create',
  processConsumableRequest: 'consumable.request.process',
  completeConsumableRequest: 'consumable.request.complete',
  cancelConsumableRequest: 'consumable.request.cancel',
  acknowledgeAlarm: 'alarm.acknowledge',
  clearAlarm: 'alarm.clear',
  createEsgExport: 'esg.export.create',
  createActivityExport: 'activity.export.create',
  createContract: 'contract.create',
  updateContract: 'contract.update',
  activateContract: 'contract.activate',
  renewContract: 'contract.renew',
  terminateContract: 'contract.terminate',
  bindContractDevices: 'contract.devices.bind',
  unbindContractDevices: 'contract.devices.unbind',
};
export function bindSuccessfulAudit(candidate, detail) {
  if (
    !candidate ||
    !detail ||
    !candidate.requestId ||
    detail.requestId !== candidate.requestId ||
    detail.actorRole !== candidate.role ||
    detail.result !== 'SUCCESS' ||
    !detail.auditId ||
    !detail.objectId ||
    !detail.action ||
    !detail.afterValue ||
    typeof detail.afterValue !== 'object' ||
    Object.keys(detail.afterValue).length === 0 ||
    (MUTATION_AUDIT_ACTIONS[candidate.operationId] && detail.action !== MUTATION_AUDIT_ACTIONS[candidate.operationId])
  )
    return null;
  // An atomic audit after-snapshot proves a committed operation, not delivery to a device or all unrelated branches.
  return {
    operationId: candidate.operationId,
    role: candidate.role,
    mutationRequestId: candidate.requestId,
    auditId: detail.auditId,
    action: detail.action,
    objectType: detail.objectType,
    objectId: detail.objectId,
    beforeValue: detail.beforeValue,
    afterValue: detail.afterValue,
    sourceCommit: candidate.sourceCommit,
    gate: 'PASS_ATOMIC_MUTATION_AUDIT_SNAPSHOT_ONLY',
  };
}
export async function collectPersistenceAudits({ token, receipt, save, priorPath }) {
  const path = 'docs/audit/evidence/qa-09-close-01-2026-10-12/reconciliation-after.json',
    bytes = readFileSync(path),
    ledger = JSON.parse(bytes);
  const candidates = ledger.pairs.flatMap((p) =>
    p.evidence.map((e) => ({
      operationId: p.operationId,
      role: p.role,
      requestId: e.requestId,
      sourceCommit: e.sourceCommit,
    })),
  );
  const byRequest = new Map(candidates.map((c) => [c.requestId, c]));
  const windows = [];
  const ownedIds = new Set();
  for (const file of [
    'docs/audit/evidence/qa-09-nonactive-data-2026-10-05/final/business.json',
    'docs/audit/evidence/qa-09-nonactive-data-2026-10-05/completed/business.json',
    'docs/audit/evidence/qa-09-remaining-writes-security-recovery-2026-10-05/writes-retest.json',
    'docs/audit/evidence/qa-09-remaining-writes-security-recovery-2026-10-05/writes-retest.json.fixtures.json',
    'docs/audit/evidence/qa-09-remaining-writes-security-recovery-2026-10-05/redelivery.json.devices.json',
    'docs/audit/evidence/qa-09-remaining-writes-security-recovery-2026-10-05/redelivery-final.json.devices.json',
  ]) {
    const b = readFileSync(file),
      x = JSON.parse(b);
    if (
      !x.startedAt ||
      !x.finishedAt ||
      !(x.cleanupComplete || (x.gate === 'PASS' && x.cleanup?.length && x.cleanup.every((c) => c.result === 'PASS')))
    )
      throw Error('ORIGINAL_EXECUTION_CLEANUP_REQUIRED');
    for (const id of [
      ...(x.devices ?? []),
      ...(x.customers ?? []).map((c) => c.id),
      ...(x.createdSites ?? []).map((c) => c.id),
      ...(x.remaining?.extraCustomers ?? []).map((c) => c.id),
    ])
      ownedIds.add(id);
    for (const q of x.checks ?? [])
      for (const segment of (q.path ?? '').split('/'))
        if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(segment) || segment.startsWith(x.prefix + '-'))
          ownedIds.add(segment);
    windows.push({ file, sha256: createHash('sha256').update(b).digest('hex'), from: x.startedAt, to: x.finishedAt });
  }
  const r = {
    scope: 'EXACT_HISTORICAL_SUCCESS_REQUEST_IDS_MATCHED_TO_RETAINED_ATOMIC_AUDIT_DETAILS',
    gate: 'RUNNING',
    ledgerSha256: createHash('sha256').update(bytes).digest('hex'),
    windows,
    reads: [],
    matched: [],
    pages: [],
    unmatched: [],
    businessWrites: 0,
    originalFailuresPreserved: true,
    fullQa09Accepted: false,
  };
  receipt.persistenceAudits = r;
  if (priorPath) {
    if (!/^build\/qa09-private-a678-followup-20261014\/persistence-audit-v2\.json$/.test(priorPath))
      throw Error('EXACT_PRIOR_AUDIT_REQUIRED');
    const b = readFileSync(priorPath),
      prior = JSON.parse(b);
    if (
      prior.gate !== 'PASS' ||
      prior.sourceCommit !== receipt.sourceCommit ||
      prior.cleanup.length !== 1 ||
      prior.cleanup[0].result !== 'PASS' ||
      prior.cleanup[0].absent !== true ||
      prior.persistenceAudits.ledgerSha256 !== r.ledgerSha256
    )
      throw Error('PRIOR_AUDIT_CLEANUP_OR_BINDING_REQUIRED');
    r.prior = { file: priorPath, sha256: createHash('sha256').update(b).digest('hex') };
    r.matched = [...prior.persistenceAudits.matched];
  }
  save();
  async function get(path) {
    const res = await fetch('https://api.bio-nexa.com' + path, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(30000),
    });
    const body = await res.json();
    const requestId = body.meta?.requestId ?? res.headers.get('x-amzn-requestid');
    r.reads.push({ method: 'GET', path: path.split('?')[0], status: res.status, requestId });
    save();
    if (res.status !== 200 || !requestId) throw Error('PERSISTENCE_AUDIT_GET_FAILED');
    return body;
  }
  const seen = new Set();
  for (const window of windows) {
    let cursor;
    for (let page = 0; page < 12; page++) {
      const q = new URLSearchParams({ from: window.from, to: window.to, limit: '100', ...(cursor ? { cursor } : {}) });
      const list = await get('/api/v1/admin/audit-logs?' + q);
      r.pages.push({ window: window.file, page, rows: list.data.length, hasNext: !!list.meta.nextCursor });
      const ownActors = new Set(
        list.data
          .filter((row) => ownedIds.has(row.objectId) || ownedIds.has(row.customerId))
          .map((row) => row.actorId)
          .filter(Boolean),
      );
      const coveredActions = new Set(r.matched.map((m) => m.action + ':' + m.role));
      for (const row of list.data) {
        // List views intentionally omit requestId. Read only owned-object details before matching exact requests.
        if (
          seen.has(row.auditId) ||
          row.result !== 'SUCCESS' ||
          !(ownedIds.has(row.objectId) || ownedIds.has(row.customerId) || ownActors.has(row.actorId)) ||
          (priorPath && coveredActions.has(row.action + ':' + row.actorRole))
        )
          continue;
        if (seen.size >= 260) throw Error('AUDIT_DETAIL_READ_BUDGET_EXHAUSTED');
        seen.add(row.auditId);
        const d = await get('/api/v1/admin/audit-logs/' + row.auditId);
        const bound = bindSuccessfulAudit(byRequest.get(d.data.requestId), d.data);
        if (bound) r.matched.push(bound);
        save();
      }
      cursor = list.meta.nextCursor;
      if (!cursor) break;
      if (page === 11) throw Error('AUDIT_READ_PAGE_BUDGET_EXHAUSTED');
    }
  }
  const covered = new Set(r.matched.map((x) => x.operationId + ':' + x.role));
  r.unmatched = ledger.pairs
    .filter((p) => !covered.has(p.operationId + ':' + p.role))
    .map((p) => ({ operationId: p.operationId, role: p.role }));
  r.gate = 'PASS_BOUNDED_READ_ONLY_AUDIT_RECONCILIATION_NOT_ALL_PAIRS';
  r.finishedAt = new Date().toISOString();
  save();
  return r;
}
