import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@fdp/database';
import type { LiveImageControlStore } from '@fdp/domain';
import { deviceCertificateMetadata } from '@fdp/aws-clients';
import { checkInvocation, checkWindow, parseWriteRequest, requireThat, Rejected, jsonHash } from './contracts.js';
import type { BoundManifest, WriteRequest, Invocation, Binding } from './contracts.js';
import {
  ensureRoot,
  readRoot,
  readReceipt,
  reserve,
  saveRoot,
  writeReceipt,
  requestHash,
  operationId,
} from './run-ledger.js';
import type { Tx, RunState, OwnedUser, OperationReceipt } from './run-ledger.js';

export interface CognitoIdentity {
  username: string;
  sub: string;
  email: string;
  enabled: boolean;
  createdAtMs: number;
  groups: string[];
  customerId: string | null;
}
export interface WriterDependencies {
  /** Trusted composition root installs the existing authority writer wrapper. Never accepted from an event. */
  client: PrismaClient;
  control: LiveImageControlStore;
  identity(username: string): Promise<CognitoIdentity>;
  now(): number;
}
export interface WriterResponse {
  status:
    | 'COMMITTED'
    | 'ROLLED_BACK'
    | 'UNKNOWN'
    | 'NOT_FOUND'
    | 'REJECTED'
    | 'SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED';
  code?: string;
  operationId: string;
  requestHash?: string;
  observedAuthEpoch?: number;
  result?: OperationReceipt['result'];
  replayed?: boolean;
}
const txOptions = { timeout: 10000, maxWait: 1000 };
export function createControlledWriter(bound: BoundManifest, deps: WriterDependencies) {
  const { manifest: m } = bound;
  async function cognito(who: 'provisioner' | 'viewer', mustBeEnabled = true) {
    const spec = m[who],
      role = who === 'provisioner' ? 'PlatformSuperAdmin' : 'CustomerViewer';
    const actual = await deps.identity(spec.username);
    requireThat(
      actual.username === spec.username &&
        actual.email === spec.email &&
        actual.sub.length > 0 &&
        actual.groups.length === 1 &&
        actual.groups[0] === role &&
        actual.enabled === mustBeEnabled &&
        actual.createdAtMs >= Date.parse(m.window.startsAt) &&
        actual.createdAtMs <= deps.now(),
      'COGNITO_IDENTITY_CHANGED',
    );
    return actual;
  }
  async function ownedUser(tx: Tx, root: RunState, who: 'provisioner' | 'viewer', enabled = true) {
    const owned = root[who];
    requireThat(owned, 'OWN_IDENTITY_REQUIRED');
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE id = $1 FOR UPDATE', owned.id);
    const row = await tx.user.findUnique({ where: { id: owned.id }, include: { roles: true, scopes: true } });
    requireThat(
      row &&
        row.cognitoSub === owned.sub &&
        row.email === m[who].email &&
        row.roles.length === 1 &&
        row.roles[0]!.roleCode === owned.role &&
        (who === 'provisioner'
          ? row.scopes.length === 0
          : row.scopes.length === 1 &&
            row.scopes[0]!.customerId === root.binding?.customerId &&
            row.scopes[0]!.siteId === null),
      'DB_IDENTITY_CHANGED',
    );
    const actual = await cognito(who, enabled);
    requireThat(
      actual.sub === owned.sub &&
        (who === 'provisioner' ? actual.customerId === null : actual.customerId === root.binding?.customerId),
      'COGNITO_SCOPE_CHANGED',
    );
    return row;
  }
  async function noForeignLeases(tx: Tx, sub: string, ownDevice?: string, forbidOwn = false) {
    let hasOwnLease = false;
    const policies = await tx.deviceLiveImagePolicy.findMany({ select: { deviceId: true } });
    for (const policy of policies) {
      const control = await deps.control.readControl(policy.deviceId);
      // Match the actual wrapper, including expired-but-retained leases which it still fences.
      if (control?.viewers.some((v) => v.actorId === sub)) {
        hasOwnLease = true;
        requireThat(!forbidOwn && policy.deviceId === ownDevice, 'FOREIGN_OR_EXISTING_ACTOR_LEASE');
      }
    }
    return hasOwnLease;
  }
  async function proveDevice(tx: Tx, root: RunState, deviceId: string, cleanup = false): Promise<Binding> {
    requireThat(root.provisioner, 'PROVISIONER_REQUIRED');
    await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id = $1 FOR UPDATE', deviceId);
    const d = await tx.device.findUnique({
      where: { id: deviceId },
      include: {
        customer: true,
        site: true,
        certificates: true,
        assignments: { where: { status: 'ACTIVE' } },
        latestState: true,
      },
    });
    requireThat(
      d &&
        d.serialNumber === m.serialNumber &&
        d.model === m.model &&
        d.createdAt.getTime() >= Date.parse(m.window.startsAt) &&
        d.customer?.name === m.customerName &&
        d.site?.name === m.siteName &&
        (cleanup ||
          (d.customer.status === 'ACTIVE' &&
            !d.customer.deletedAt &&
            d.site.status === 'ACTIVE' &&
            !d.site.deletedAt)) &&
        d.site.customerId === d.customerId &&
        d.assignments.length === 1 &&
        d.assignments[0]!.assignedBy === root.provisioner.sub &&
        d.assignments[0]!.customerId === d.customerId &&
        d.assignments[0]!.siteId === d.siteId,
      'DEVICE_OR_TENANT_CHANGED',
    );
    requireThat(
      (await tx.device.count({ where: { customerId: d.customerId } })) === 1 &&
        (await tx.site.count({ where: { customerId: d.customerId! } })) === 1,
      'ISOLATED_CUSTOMER_REQUIRED',
    );
    const ob = await tx.onboardingRequest.findUnique({ where: { serialNumber: m.serialNumber } });
    requireThat(
      ob &&
        ob.status === 'APPROVED' &&
        ob.reviewedBy === root.provisioner.sub &&
        ob.publicKeyFingerprint === m.csrPublicKeyFingerprint &&
        ob.model === m.model &&
        ob.createdAt.getTime() >= Date.parse(m.window.startsAt) &&
        ob.reviewedAt &&
        ob.reviewedAt.getTime() >= Date.parse(m.window.startsAt),
      'OWN_APPROVAL_REQUIRED',
    );
    for (const [type, id, action] of [
      ['customer', d.customerId, 'customer.create'],
      ['site', d.siteId, 'site.create'],
      ['device', d.id, 'device.assignment.assign'],
      ['onboarding_request', ob.id, 'onboarding.request.approve'],
    ] as const) {
      const audit = await tx.auditLog.findFirst({
        where: {
          objectType: type,
          objectId: id!,
          action,
          result: 'SUCCESS',
          actorId: root.provisioner.sub,
          createdAt: { gte: new Date(m.window.startsAt) },
        },
      });
      requireThat(audit, 'OWN_PROVENANCE_REQUIRED');
    }
    const current = d.certificates.filter((c) =>
      cleanup
        ? c.id === root.binding?.certificateId
        : c.status === 'ACTIVE' &&
          !c.revokedAt &&
          c.notBefore.getTime() <= deps.now() &&
          deps.now() < c.notAfter.getTime() &&
          !c.iotDeactivationPending &&
          (!c.rotationDeadlineAt || !!c.rotationConfirmedAt),
    );
    requireThat(current.length === 1, 'ONE_CURRENT_CERTIFICATE_REQUIRED');
    const cert = current[0]!;
    requireThat(
      cert.certificatePem && cert.publicKeyFingerprint === m.csrPublicKeyFingerprint,
      'CSR_CERTIFICATE_MISMATCH',
    );
    const derived = deviceCertificateMetadata(cert.certificatePem);
    requireThat(
      derived.fingerprint === cert.fingerprint &&
        derived.publicKeyFingerprint === m.csrPublicKeyFingerprint &&
        derived.notBefore.getTime() === cert.notBefore.getTime() &&
        derived.notAfter.getTime() === cert.notAfter.getTime(),
      'CERTIFICATE_METADATA_MISMATCH',
    );
    const binding: Binding = {
      deviceId: d.id,
      customerId: d.customerId!,
      siteId: d.siteId!,
      certificateFingerprint: cert.fingerprint,
      certificateId: cert.id,
    };
    if (root.binding) requireThat(jsonHash(root.binding) === jsonHash(binding), 'IMMUTABLE_BINDING_CHANGED');
    return binding;
  }
  async function epoch(root: RunState, req: WriteRequest) {
    requireThat(
      root.binding && req.deviceId === root.binding.deviceId && req.expectedAuthEpoch !== undefined,
      'OWN_DEVICE_EPOCH_REQUIRED',
    );
    const control = await deps.control.readControl(root.binding.deviceId);
    requireThat(
      (control?.authEpoch ?? 0) === req.expectedAuthEpoch &&
        (!control || control.customerId === root.binding.customerId),
      'AUTHORITY_EPOCH_CHANGED',
    );
  }
  async function work(tx: Tx, root: RunState, req: WriteRequest): Promise<NonNullable<OperationReceipt['result']>> {
    checkWindow(bound, deps.now());
    const role = req.action === 'SEED_PROVISIONER' ? 'provisioner' : 'viewer';
    if (req.action.startsWith('SEED_')) {
      requireThat(!root[role], 'IDENTITY_ALREADY_BOUND');
      const actual = await cognito(role);
      requireThat(
        actual.customerId === (role === 'provisioner' ? null : root.binding?.customerId),
        'OWN_CUSTOMER_REQUIRED',
      );
      if (role === 'viewer') {
        requireThat(root.binding, 'OWN_DEVICE_REQUIRED');
        const admin = await ownedUser(tx, root, 'provisioner');
        requireThat(admin.status === 'ACTIVE', 'PROVISIONER_NOT_ACTIVE');
        await proveDevice(tx, root, root.binding.deviceId);
      }
      requireThat(
        !(await tx.user.findFirst({ where: { OR: [{ cognitoSub: actual.sub }, { email: actual.email }] } })),
        'EXISTING_DB_IDENTITY_REJECTED',
      );
      await noForeignLeases(tx, actual.sub, undefined, true);
      checkWindow(bound, deps.now());
      const user: OwnedUser = {
        id: randomUUID(),
        sub: actual.sub,
        username: actual.username,
        role: role === 'provisioner' ? 'PlatformSuperAdmin' : 'CustomerViewer',
      };
      await tx.user.create({
        data: {
          id: user.id,
          email: actual.email,
          displayName: actual.username,
          cognitoSub: actual.sub,
          status: 'INVITED',
          roles: { create: { roleCode: user.role } },
          ...(role === 'viewer' ? { scopes: { create: { customerId: root.binding!.customerId } } } : {}),
        },
      });
      root[role] = user;
      await saveRoot(tx, bound, root);
      return { userId: user.id, cognitoSub: user.sub, status: 'INVITED' };
    }
    const cleaningAdmin = req.action === 'DISABLE_IDENTITY' && req.userId === root.provisioner?.id;
    if (!cleaningAdmin) {
      const admin = await ownedUser(tx, root, 'provisioner');
      requireThat(admin.status === 'ACTIVE', 'PROVISIONER_NOT_ACTIVE');
    }
    if (req.action === 'BIND_DEVICE') {
      requireThat(!root.binding, 'DEVICE_ALREADY_BOUND');
      root.binding = await proveDevice(tx, root, req.deviceId!);
      checkWindow(bound, deps.now());
      await saveRoot(tx, bound, root);
      return { ...root.binding };
    }
    if (req.action === 'DISABLE_IDENTITY') {
      const who =
        req.userId === root.provisioner?.id ? 'provisioner' : req.userId === root.viewer?.id ? 'viewer' : null;
      requireThat(who, 'OWN_IDENTITY_REQUIRED');
      // Cognito disable is a separate coordinator action, never granted to this Writer.
      const row = await ownedUser(tx, root, who, false);
      requireThat(
        row.status === 'ACTIVE' || row.status === 'INVITED' || row.status === 'DISABLED',
        'DB_IDENTITY_CHANGED',
      );
      if (root.binding) {
        await proveDevice(tx, root, root.binding.deviceId, true);
        await epoch(root, req);
      } else
        requireThat(
          req.deviceId === undefined && req.expectedAuthEpoch === undefined,
          'UNBOUND_DEVICE_FIELDS_REJECTED',
        );
      const hasLease = await noForeignLeases(tx, root[who]!.sub, root.binding?.deviceId, !root.binding);
      if (who === 'provisioner') {
        if (root.viewer)
          requireThat(
            (await tx.user.findUnique({ where: { id: root.viewer.id } }))?.status === 'DISABLED',
            'DISABLE_VIEWER_FIRST',
          );
        const otherAdmins = await tx.user.count({
          where: {
            id: { not: row.id },
            status: { not: 'DISABLED' },
            roles: { some: { roleCode: 'PlatformSuperAdmin' } },
          },
        });
        requireThat(otherAdmins > 0, 'LAST_SUPER_ADMIN');
      }
      checkWindow(bound, deps.now());
      await tx.user.update({ where: { id: row.id }, data: { status: 'DISABLED' } });
      return {
        userId: row.id,
        status: 'DISABLED',
        beforeAuthEpoch: req.expectedAuthEpoch ?? null,
        fenceRequired: hasLease,
      };
    }
    requireThat(root.binding && root.binding.deviceId === req.deviceId, 'OWN_DEVICE_REQUIRED');
    await proveDevice(tx, root, req.deviceId!, req.action === 'DISABLE_PREVIEW');
    await epoch(root, req);
    const enabled = req.action === 'ENABLE_PREVIEW';
    if (enabled) {
      const d = await tx.device.findUnique({ where: { id: req.deviceId! }, include: { latestState: true } });
      requireThat(
        d &&
          ['Active', 'Maintenance'].includes(d.lifecycleStatus) &&
          ['Active', 'Maintenance'].includes(d.latestState?.operationalStatus ?? ''),
        'DEVICE_NOT_ELIGIBLE',
      );
      const viewer = await ownedUser(tx, root, 'viewer');
      requireThat(viewer.status === 'ACTIVE', 'VIEWER_NOT_ACTIVE');
    }
    checkWindow(bound, deps.now());
    await tx.deviceLiveImagePolicy.upsert({
      where: { deviceId: req.deviceId! },
      create: { deviceId: req.deviceId!, enabled },
      update: { enabled },
    });
    return { deviceId: req.deviceId!, enabled, beforeAuthEpoch: req.expectedAuthEpoch!, fenceRequired: true };
  }
  async function report(
    req: WriteRequest,
    receipt: OperationReceipt | null,
    root: RunState | null,
    replayed: boolean,
  ): Promise<WriterResponse> {
    if (!receipt) return { status: 'NOT_FOUND', operationId: req.operationId };
    const base = { operationId: req.operationId, requestHash: receipt.requestHash, result: receipt.result, replayed };
    if (receipt.state === 'IN_PROGRESS')
      return { status: 'UNKNOWN', code: 'QUERY_AND_RECONCILE_DO_NOT_RETRY', ...base };
    if (receipt.state === 'ROLLED_BACK') return { status: 'ROLLED_BACK', ...base };
    if (
      root?.binding &&
      receipt.result?.fenceRequired === true &&
      typeof receipt.result?.beforeAuthEpoch === 'number'
    ) {
      try {
        const c = await deps.control.readControl(root.binding.deviceId);
        const device = await deps.client.device.findUnique({
          where: { id: root.binding.deviceId },
          include: { liveImagePolicy: true, latestState: true },
        });
        const expected =
          !!device?.liveImagePolicy?.enabled &&
          !!device.customerId &&
          ['Active', 'Maintenance'].includes(device.lifecycleStatus) &&
          ['Active', 'Maintenance'].includes(device.latestState?.operationalStatus ?? '');
        if (
          c &&
          c.customerId === root.binding.customerId &&
          c.authEpoch > receipt.result.beforeAuthEpoch &&
          c.enabled === expected
        )
          return { status: 'COMMITTED', ...base, observedAuthEpoch: c.authEpoch };
        if (c && !c.enabled)
          return {
            status: 'SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED',
            code: 'DO_NOT_REPLAY_BUSINESS_WRITE',
            ...base,
          };
        return { status: 'UNKNOWN', code: 'SQL_COMMITTED_CONTROL_STATE_UNPROVEN', ...base };
      } catch {
        return { status: 'UNKNOWN', code: 'SQL_COMMITTED_CONTROL_OBSERVATION_UNAVAILABLE', ...base };
      }
    }
    return { status: 'COMMITTED', ...base };
  }
  return async function execute(event: unknown, context: Invocation): Promise<WriterResponse> {
    let req: WriteRequest;
    try {
      checkInvocation(bound, 'writer', context);
      req = parseWriteRequest(event, bound);
      if (req.action !== 'READ_OPERATION') checkWindow(bound, deps.now());
    } catch (e) {
      return { status: 'REJECTED', code: e instanceof Rejected ? e.code : 'INVALID_REQUEST', operationId: '' };
    }
    if (req.action === 'READ_OPERATION') {
      try {
        const read = await deps.client.$transaction(
          async (tx) => ({ root: await readRoot(tx, bound), receipt: await readReceipt(tx, bound, req) }),
          txOptions,
        );
        return await report(req, read.receipt, read.root, true);
      } catch {
        return { status: 'UNKNOWN', code: 'QUERY_UNAVAILABLE', operationId: req.operationId };
      }
    }
    let prior: OperationReceipt | null;
    try {
      prior = await deps.client.$transaction(async (tx) => {
        checkWindow(bound, deps.now());
        await ensureRoot(tx, bound);
        return reserve(tx, bound, req);
      }, txOptions);
    } catch (e) {
      return {
        status: e instanceof Rejected ? 'REJECTED' : 'UNKNOWN',
        code: e instanceof Rejected ? e.code : 'RESERVATION_OUTCOME_UNKNOWN',
        operationId: req.operationId,
      };
    }
    if (prior) {
      try {
        return await report(req, prior, await readRoot(deps.client, bound), true);
      } catch {
        return { status: 'UNKNOWN', code: 'QUERY_UNAVAILABLE', operationId: req.operationId };
      }
    }
    let callbackFailed = false;
    try {
      await deps.client.$transaction(async (tx) => {
        try {
          const root = await ensureRoot(tx, bound),
            receipt = await readReceipt(tx, bound, req);
          requireThat(receipt?.state === 'IN_PROGRESS' && receipt.requestHash === requestHash(req), 'RECEIPT_CHANGED');
          const result = await work(tx, root, req);
          if (typeof result.beforeAuthEpoch === 'number') {
            const fenced = await deps.control.readControl(root.binding!.deviceId);
            result.fencedAuthEpoch = fenced?.authEpoch ?? 0;
            if (result.fenceRequired === true)
              requireThat(
                fenced &&
                  !fenced.enabled &&
                  fenced.customerId === root.binding!.customerId &&
                  fenced.authEpoch > result.beforeAuthEpoch,
                'CONTROL_FENCE_REQUIRED',
              );
          }
          checkWindow(bound, deps.now());
          // Business mutation, immutable binding and successful receipt share this exact PG transaction.
          await writeReceipt(tx, bound, req, 'COMMITTED', result);
          checkWindow(bound, deps.now());
        } catch (e) {
          callbackFailed = true;
          throw e;
        }
      }, txOptions);
    } catch (e) {
      if (!callbackFailed)
        return { status: 'UNKNOWN', code: 'COMMIT_OUTCOME_UNKNOWN_QUERY_RECEIPT', operationId: req.operationId };
      try {
        await deps.client.$transaction(async (tx) => {
          const receipt = await readReceipt(tx, bound, req);
          if (receipt?.state === 'IN_PROGRESS')
            await writeReceipt(tx, bound, req, 'ROLLED_BACK', {
              code: e instanceof Rejected ? e.code : 'TRANSACTION_ABORTED',
            });
        }, txOptions);
        return {
          status: 'ROLLED_BACK',
          code: e instanceof Rejected ? e.code : 'TRANSACTION_ABORTED',
          operationId: req.operationId,
        };
      } catch {
        return { status: 'UNKNOWN', code: 'ROLLBACK_RECEIPT_UNAVAILABLE', operationId: req.operationId };
      }
    }
    try {
      const root = await readRoot(deps.client, bound),
        receipt = await readReceipt(deps.client, bound, req);
      const response = await report(req, receipt, root, false);
      if (response.status === 'SQL_COMMITTED_PREVIEW_CLOSED_RECOVERY_REQUIRED') {
        // Separate recovery observation; cannot change the already committed business receipt into FAILURE.
        await deps.client.auditLog.upsert({
          where: { id: operationId(bound, req) + ':recovery' },
          create: {
            id: operationId(bound, req) + ':recovery',
            objectType: 'IMG21_RECOVERY',
            objectId: m.runId,
            action: 'img21.preview.recovery_required',
            result: 'FAILURE',
            afterValue: { operationId: req.operationId, requestHash: requestHash(req) },
          },
          update: {},
        });
      }
      return response;
    } catch {
      return { status: 'UNKNOWN', code: 'POST_COMMIT_QUERY_UNAVAILABLE', operationId: req.operationId };
    }
  };
}
