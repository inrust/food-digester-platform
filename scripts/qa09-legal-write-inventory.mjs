import { WRITES, writePermission } from './qa09-write-boundary-probes.mjs';
import { hasPermission } from '../packages/auth/src/permissions.ts';
import { ROLES } from './qa09-business-target.mjs';
export function legalWriteInventory(checks) {
  return WRITES.map((operation) => {
    const pattern = new RegExp(
      '^' +
        operation.path
          .split(/(\{[^}]+\})/)
          .map((part) => (part.startsWith('{') ? '[^/]+' : part.replace(/[.*+?^$()|[\]\\]/g, '\\$&')))
          .join('') +
        '$',
    );
    return {
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      permission: writePermission(operation),
      roles: ROLES.map((role) => {
        if (!hasPermission(role, writePermission(operation)))
          return { role, result: 'NOT_APPLICABLE', reason: 'ROLE_HAS_NO_WRITE_PERMISSION' };
        const rows = checks.filter(
          (c) =>
            c.role === role &&
            c.method === operation.method &&
            pattern.test(c.path) &&
            c.result === 'PASS' &&
            c.status >= 200 &&
            c.status < 300,
        );
        return {
          role,
          result: rows.length ? 'HTTP_SUCCESS_OBSERVED' : 'NOT_RUN',
          checks: rows.map((c) => ({ id: c.id, requestId: c.requestId, status: c.status })),
          persistenceAcceptance: 'SEE_EXPLICIT_READBACK_AND_DATABASE_RECEIPTS',
        };
      }),
    };
  });
}
