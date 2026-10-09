import type { DbClient } from '@fdp/database';

export interface ContractUpdateReadRow {
  readonly id: string;
  readonly contractNumber: string;
  readonly name: string;
  readonly customerId: string;
  readonly contact: string | null;
  readonly startAt: Date;
  readonly endAt: Date;
  readonly status: string;
  readonly version: number;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Explicit offline/service opt-in only. No runtime/env deployment switch is wired. */
export async function readContractForUpdate(
  tx: DbClient,
  id: string,
  candidate = false,
): Promise<ContractUpdateReadRow | null> {
  if (candidate !== true) return tx.contract.findFirst({ where: { id } });
  if (process.env.FDP_DB_POOL_MAX !== '1' || typeof (tx as { $connect?: unknown }).$connect === 'function')
    throw Error('CONTRACT_READ_CANDIDATE_REQUIRES_POOL1_TRANSACTION');
  const rows = await tx.$queryRaw<ContractUpdateReadRow[]>`
    SELECT id, contract_number AS "contractNumber", name, customer_id AS "customerId", contact,
      start_at AS "startAt", end_at AS "endAt", status, version, created_by AS "createdBy",
      created_at AS "createdAt", updated_at AS "updatedAt"
    FROM "public"."contracts" WHERE id = ${id} LIMIT 1
  `;
  if (!Array.isArray(rows) || rows.length > 1) throw Error('INVALID_CONTRACT_READ_CANDIDATE_RESULT');
  if (rows.length === 0) return null;
  const row = rows[0]!;
  if (
    !row ||
    row.id !== id ||
    !['id', 'contractNumber', 'name', 'customerId', 'status', 'createdBy'].every(
      (k) => typeof row[k as keyof ContractUpdateReadRow] === 'string',
    ) ||
    !(row.contact === null || typeof row.contact === 'string') ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    !['startAt', 'endAt', 'createdAt', 'updatedAt'].every(
      (k) =>
        row[k as keyof ContractUpdateReadRow] instanceof Date &&
        Number.isFinite((row[k as keyof ContractUpdateReadRow] as Date).getTime()),
    )
  )
    throw Error('INVALID_CONTRACT_READ_CANDIDATE_RESULT');
  return row;
}
