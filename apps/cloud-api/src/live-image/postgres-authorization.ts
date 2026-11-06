import { actorTypeOf, isRole, verifyDeviceCertificate } from '@fdp/auth';
import type { ActorContext } from '@fdp/auth';
import {
  lockLiveImageAuthority,
  withTransaction,
  withLiveImageReadTransaction,
  withLiveImageIoLifetime,
} from '@fdp/database';
import type { DbClient, Prisma } from '@fdp/database';
import type { LiveImageAccess, LiveImageAuthorizationGuard, LiveImageAuthorizationScope } from './storage.js';
import { assertLiveImageViewer, LiveImageLeaseError } from './service.js';

export class PostgresLiveImageAuthorization implements LiveImageAuthorizationGuard {
  constructor(
    private readonly client: DbClient,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private async scope(
    tx: Prisma.TransactionClient,
    deviceId: string,
    actor?: ActorContext,
  ): Promise<LiveImageAuthorizationScope> {
    await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id = $1 FOR SHARE', deviceId);
    const device = await tx.device.findUnique({
      where: { id: deviceId },
      include: { latestState: true, liveImagePolicy: true },
    });
    if (!device) throw new LiveImageLeaseError('NOT_FOUND');
    return {
      deviceId,
      customerId: device.customerId,
      lifecycleStatus: device.lifecycleStatus,
      operationalStatus: device.latestState?.operationalStatus ?? null,
      featureEnabled: device.liveImagePolicy?.enabled ?? false,
      ...(actor ? { actor } : {}),
    };
  }
  private async actor(tx: Prisma.TransactionClient, input: ActorContext): Promise<ActorContext> {
    await tx.$queryRawUnsafe('SELECT id FROM users WHERE cognito_sub = $1 FOR SHARE', input.actorId);
    const user = await tx.user.findUnique({
      where: { cognitoSub: input.actorId },
      include: { roles: true, scopes: true },
    });
    if (!user || user.status !== 'ACTIVE') throw new LiveImageLeaseError('FORBIDDEN');
    const roles = user.roles.map((r) => r.roleCode);
    if (!roles.length || !roles.every(isRole)) throw new LiveImageLeaseError('FORBIDDEN');
    const types = new Set(roles.map(actorTypeOf));
    if (types.size !== 1) throw new LiveImageLeaseError('FORBIDDEN');
    const actorType = actorTypeOf(roles[0]!);
    const customers = new Set(user.scopes.map((s) => s.customerId).filter((id): id is string => !!id));
    if (actorType === 'customer' && customers.size !== 1) throw new LiveImageLeaseError('FORBIDDEN');
    return { ...input, roles, actorType, customerId: actorType === 'customer' ? [...customers][0]! : null };
  }
  withRead<T>(access: LiveImageAccess, work: (scope: LiveImageAuthorizationScope) => Promise<T>): Promise<T> {
    return withLiveImageReadTransaction(this.client, async (tx) => {
      if (access.kind === 'viewer') {
        const freshActor = await this.actor(tx, access.actor);
        const scope = await this.scope(tx, access.deviceId, freshActor);
        assertLiveImageViewer(scope, access);
        return work(scope);
      }
      const identity = await verifyDeviceCertificate(tx, access.identity, { now: this.now() });
      const scope = await this.scope(tx, identity.deviceId);
      return work(scope);
    });
  }
  withExclusive<T>(deviceId: string, work: (scope: LiveImageAuthorizationScope) => Promise<T>): Promise<T> {
    return withLiveImageIoLifetime(() =>
      withTransaction(
        this.client,
        async (tx) => {
          await lockLiveImageAuthority(tx, 'write');
          return work(await this.scope(tx, deviceId));
        },
        { timeout: 10000, maxWait: 1000 },
      ),
    );
  }
}
