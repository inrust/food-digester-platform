import type { Prisma } from '@fdp/database';
import type { Binding, BoundManifest, WriteRequest } from './contracts.js';
import { jsonHash, requireThat } from './contracts.js';
export type Tx = Prisma.TransactionClient;
export interface OwnedUser {
  id: string;
  sub: string;
  username: string;
  role: string;
}
export interface RunState {
  manifestHash: string;
  binding: Binding | null;
  provisioner: OwnedUser | null;
  viewer: OwnedUser | null;
}
export type ReceiptState = 'IN_PROGRESS' | 'COMMITTED' | 'ROLLED_BACK';
export interface OperationReceipt {
  requestHash: string;
  state: ReceiptState;
  action: string;
  result: Record<string, string | number | boolean | null> | null;
}
export const rootId = (bound: BoundManifest) => `img21:run:${bound.manifest.runId}`;
export const operationId = (bound: BoundManifest, request: WriteRequest) =>
  `img21:op:${bound.manifest.runId}:${request.operationId}`;
export const requestHash = (request: WriteRequest) => jsonHash(request);
export async function readRoot(tx: Tx, bound: BoundManifest): Promise<RunState | null> {
  const row = await tx.auditLog.findUnique({ where: { id: rootId(bound) } });
  if (!row) return null;
  const state = row.afterValue as unknown as RunState;
  requireThat(
    row.objectType === 'IMG21_RUN' && row.objectId === bound.manifest.runId && state?.manifestHash === bound.hash,
    'RUN_MANIFEST_CONFLICT',
  );
  return state;
}
export async function ensureRoot(tx: Tx, bound: BoundManifest) {
  let state = await readRoot(tx, bound);
  if (!state) {
    state = { manifestHash: bound.hash, binding: null, provisioner: null, viewer: null };
    await tx.auditLog.create({
      data: {
        id: rootId(bound),
        objectType: 'IMG21_RUN',
        objectId: bound.manifest.runId,
        action: 'img21.run.open',
        result: 'SUCCESS',
        afterValue: state as unknown as Prisma.InputJsonValue,
      },
    });
  }
  await tx.$queryRawUnsafe('SELECT id FROM audit_logs WHERE id = $1 FOR UPDATE', rootId(bound));
  return state;
}
export async function saveRoot(tx: Tx, bound: BoundManifest, state: RunState) {
  await tx.auditLog.update({
    where: { id: rootId(bound) },
    data: { afterValue: state as unknown as Prisma.InputJsonValue },
  });
}
export async function readReceipt(
  tx: Tx,
  bound: BoundManifest,
  request: WriteRequest,
): Promise<OperationReceipt | null> {
  const row = await tx.auditLog.findUnique({ where: { id: operationId(bound, request) } });
  if (!row) return null;
  requireThat(
    row.objectType === 'IMG21_OPERATION' && row.objectId === bound.manifest.runId,
    'RECEIPT_CONTEXT_CONFLICT',
  );
  const r = row.afterValue as unknown as OperationReceipt;
  requireThat(
    r && ['IN_PROGRESS', 'COMMITTED', 'ROLLED_BACK'].includes(r.state) && typeof r.requestHash === 'string',
    'INVALID_RECEIPT',
  );
  return r;
}
export async function reserve(tx: Tx, bound: BoundManifest, request: WriteRequest) {
  const hash = requestHash(request),
    existing = await readReceipt(tx, bound, request);
  if (existing) {
    requireThat(existing.requestHash === hash, 'IDEMPOTENCY_CONFLICT');
    return existing;
  }
  const receipt: OperationReceipt = { requestHash: hash, state: 'IN_PROGRESS', action: request.action, result: null };
  await tx.auditLog.create({
    data: {
      id: operationId(bound, request),
      objectType: 'IMG21_OPERATION',
      objectId: bound.manifest.runId,
      action: 'img21.operation',
      result: 'FAILURE',
      requestId: request.operationId,
      afterValue: receipt as unknown as Prisma.InputJsonValue,
    },
  });
  return null;
}
export async function writeReceipt(
  tx: Tx,
  bound: BoundManifest,
  request: WriteRequest,
  state: 'COMMITTED' | 'ROLLED_BACK',
  result: OperationReceipt['result'],
) {
  await tx.auditLog.update({
    where: { id: operationId(bound, request) },
    data: {
      result: state === 'COMMITTED' ? 'SUCCESS' : 'FAILURE',
      afterValue: { requestHash: requestHash(request), state, action: request.action, result } as Prisma.InputJsonValue,
    },
  });
}
