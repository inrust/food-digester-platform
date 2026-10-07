import type { DbClient } from '@fdp/database';

export interface AuthenticatedAccountState {
  readonly id: string;
  readonly status: string;
}

/** Offline opt-in only. Runtime hooks do not enable this candidate; no status cache or extra pool. */
export async function readAuthenticatedAccount(
  client: DbClient,
  cognitoSub: string,
  candidate = false,
): Promise<AuthenticatedAccountState | null> {
  if (candidate !== true) return client.user.findFirst({ where: { cognitoSub } });
  const rows = await client.$queryRaw<AuthenticatedAccountState[]>`
    SELECT id, status FROM "public"."users" WHERE cognito_sub = ${cognitoSub} LIMIT 1
  `;
  return rows[0] ?? null;
}
