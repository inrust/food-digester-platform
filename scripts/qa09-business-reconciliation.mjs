/** Evidence inventory only: HTTP coverage is never full persistence or QA09 acceptance. */
export function operationMatches(operation, row) {
  const path = row.path?.split('?')[0];
  if (operation.method !== row.method || typeof path !== 'string') return false;
  const pattern = operation.path
    .split(/(\{[^}]+\})/)
    .map((p) => (p.startsWith('{') ? '[^/]+' : p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp('^' + pattern + '$').test(path);
}
export function reconcileLegalWrites(operations, receipts) {
  const keys = new Set();
  const requestOwners = new Map();
  const pairs = operations.flatMap((o) =>
    o.roles
      .filter((r) => r.result !== 'NOT_APPLICABLE')
      .map((r) => {
        const key = o.operationId + ':' + r.role;
        if (keys.has(key)) throw Error('DUPLICATE_OPERATION_ROLE');
        keys.add(key);
        const evidence = [];
        const ids = new Map();
        const add = (entry) => {
          if (!entry.requestId || !Number.isInteger(entry.status) || entry.status < 200 || entry.status >= 300)
            throw Error('SUCCESS_REQUEST_PROOF_REQUIRED');
          const identity = entry.sourceCommit + ':' + entry.requestId;
          const value = JSON.stringify([entry.status, entry.role, o.operationId]);
          if (requestOwners.has(identity) && requestOwners.get(identity) !== value)
            throw Error('CROSS_PAIR_REQUEST_CONFLICT');
          requestOwners.set(identity, value);
          if (ids.has(identity) && ids.get(identity) !== value) throw Error('CONFLICTING_REQUEST_EVIDENCE');
          if (!ids.has(identity)) {
            ids.set(identity, value);
            evidence.push(entry);
          }
        };
        for (const receipt of receipts) {
          if (!/^[a-f0-9]{40}$/.test(receipt.sourceCommit) || !/^[a-f0-9]{64}$/.test(receipt.sha256))
            throw Error('CONTENT_AND_VERSION_BINDING_REQUIRED');
          for (const row of receipt.rows) {
            if (row.role !== r.role || row.result !== 'PASS' || row.status < 200 || row.status >= 300) continue;
            if (row.operationId ? row.operationId !== o.operationId : !operationMatches(o, row)) continue;
            if (row.operationId && (row.method || row.path) && !operationMatches(o, row)) continue;
            add({
              sourceCommit: receipt.sourceCommit,
              receipt: receipt.path,
              sha256: receipt.sha256,
              requestId: row.requestId,
              status: row.status,
              role: row.role,
              compatibility: receipt.compatibility,
              cleanup: receipt.cleanup,
              scope: receipt.scope,
            });
          }
        }
        return {
          operationId: o.operationId,
          role: r.role,
          method: o.method,
          path: o.path,
          historicalHttpSuccess: evidence.length > 0,
          evidence,
          currentlyVersionBoundHttpSuccess: evidence.some(
            (x) => x.compatibility === 'CURRENT_LIVE_VERSION_BOUND' && x.cleanup === 'PASS',
          ),
          persistenceAcceptance: 'DOMAIN_READBACK_REQUIRED_NOT_IMPLIED_BY_HTTP_COVERAGE',
          fullQa09Accepted: false,
        };
      }),
  );
  return {
    scope: 'LEGAL_WRITE_HTTP_EVIDENCE_RECONCILIATION_NOT_FULL_BUSINESS_ACCEPTANCE',
    pairs,
    candidatePairs: pairs.length,
    historicallyObservedPairs: pairs.filter((x) => x.historicalHttpSuccess).length,
    currentLiveVersionObservedPairs: pairs.filter((x) => x.currentlyVersionBoundHttpSuccess).length,
    fullQa09Accepted: false,
  };
}
export function assertScopedSignedSession(r) {
  const roles = ['PlatformSuperAdmin', 'PlatformOperator', 'Auditor', 'CustomerAdmin', 'CustomerViewer'];
  if (
    r.scope !== 'FRESH_SIGNED_TOKENS_BUSINESS_DISABLE_USER_ROLES_AND_SCOPE' ||
    r.gate !== 'PASS_SCOPED_FIVE_ROLE_SIGNED_SESSION_AND_USER_WRITES' ||
    !r.finishedAt ||
    r.fullQa09Accepted !== false ||
    r.credentialsExported !== false ||
    r.users?.length !== 5 ||
    new Set(r.users.map((u) => u.role)).size !== 5 ||
    !r.cleanup?.length ||
    r.cleanup.some((c) => c.result !== 'PASS') ||
    !r.checks?.length ||
    r.checks.some((c) => c.result !== 'PASS')
  )
    throw Error('SIGNED_SCOPE_AND_CLEANUP_REQUIRED');
  for (const role of roles) {
    const own = r.users.find((u) => u.role === role);
    if (!own?.businessDisabled || !own.cognitoDeleted || own.failureCode) throw Error('SIGNED_USER_CLOSURE_REQUIRED');
    for (const suffix of ['business-active', 'business-disabled', 'same-unexpired-token', 'post-requests-unexpired'])
      if (!r.checks.some((c) => c.id === role + ':' + suffix && c.result === 'PASS'))
        throw Error('SIGNED_ACCOUNT_STATE_PROOF_REQUIRED');
    for (const suffix of ['disabled-old-token-read', 'disabled-old-token-write'])
      if (!r.requests.some((q) => q.id === role + ':' + suffix && q.status === 401 && q.gatewayRequestId))
        throw Error('UNEXPIRED_DISABLED_TOKEN_REJECTION_REQUIRED');
  }
  return { scope: r.scope, gate: 'PASS', fullQa09Accepted: false };
}
export function signedWriteRows(r) {
  assertScopedSignedSession(r);
  // In this frozen executor, every successful mutation is issued by admin(rootSession()).
  // Other sessions only issue reads and denied writes after disabling themselves.
  return r.requests
    .filter((q) => q.method !== 'GET' && q.status >= 200 && q.status < 300)
    .map((q) => ({ ...q, role: 'PlatformSuperAdmin', result: 'PASS', requestId: q.gatewayRequestId }));
}
