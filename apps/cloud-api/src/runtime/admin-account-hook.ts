import type { ActorContext } from '@fdp/auth';
import type { PrismaClient } from '@fdp/database';
import { activateInvitedUserOnAuthenticatedRequest } from '../admin/user/service.js';

/** Router calls this only after signed JWT and JSON validation; never cache account status. */
export function createAdminAuthenticatedAccountHook(
  client: PrismaClient,
  prepare: () => Promise<void>,
  observeProcessCpu: boolean,
): (actor: ActorContext, requestId: string) => Promise<void> {
  return async (actor, requestId) => {
    await prepare();
    await activateInvitedUserOnAuthenticatedRequest({ client, observeProcessCpu }, actor, requestId);
  };
}
