import { createHash } from 'node:crypto';
export function closedCommandLedger(business, devices, databaseProof) {
  const prefix = devices.prefix;
  if (
    !/^qa09-[a-f0-9]{16}$/.test(prefix) ||
    business.prefix !== prefix ||
    !devices.finishedAt ||
    devices.gate !== 'PASS' ||
    devices.cleanup?.some((r) => r.result !== 'PASS') ||
    !devices.cleanup?.some((r) => r.type === 'database-fixtures' && r.count === 10 && r.result === 'PASS') ||
    !business.cleanup?.some((r) => r.scope === 'business-fixtures' && r.result === 'PASS')
  )
    throw Error('CLOSED_OWN_LEDGER_REQUIRED');
  const expected = Array.from({ length: 20 }, (_, i) => `${prefix.toUpperCase()}-CMD-${i}`);
  const commands = business.result?.commands ?? [];
  if (
    commands.length !== 20 ||
    new Set(commands.map((r) => r.commandId)).size !== 20 ||
    commands.some((r) => !expected.includes(r.commandId))
  )
    throw Error('EXACT_COMMAND_LEDGER_REQUIRED');
  if (
    databaseProof.scope !== 'EXACT_RETIRED_COMMAND_POINTER_READ_ONLY' ||
    databaseProof.writes !== 0 ||
    JSON.stringify(databaseProof.commandIds) !== JSON.stringify(expected) ||
    databaseProof.remaining?.length !== 0 ||
    databaseProof.outboxRemaining?.length !== 0
  )
    throw Error('LIVE_RETIRED_COMMAND_PROOF_REQUIRED');
  return new Set(expected);
}
export function classifyDlqBody(body, ledger) {
  const bodySha256 = createHash('sha256').update(body).digest('hex');
  try {
    const value = JSON.parse(body);
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      typeof value.commandId === 'string' &&
      ledger.has(value.commandId)
    )
      return { disposition: 'DELETE_EXACT_RETIRED_OWN_POINTER', commandId: value.commandId, bodySha256 };
  } catch {
    /* unknown content stays untouched */
  }
  return { disposition: 'PRESERVE_UNKNOWN', bodySha256 };
}
