import type { DbClient } from '@fdp/database';

export interface AuthenticatedAccountState {
  readonly id: string;
  readonly status: string;
  readonly lastDisabledAt: Date | null;
}

/** Explicit opt-in only. Guarded test runtime or offline comparison; no status cache or extra pool. */
export async function readAuthenticatedAccount(
  client: DbClient,
  cognitoSub: string,
  candidate = false,
): Promise<AuthenticatedAccountState | null> {
  if (candidate !== true) return client.user.findFirst({ where: { cognitoSub } });
  const rows = await client.$queryRaw<AuthenticatedAccountState[]>`
    SELECT id, status, last_disabled_at AS "lastDisabledAt" FROM "public"."users" WHERE cognito_sub = ${cognitoSub} LIMIT 1
  `;
  return rows[0] ?? null;
}
