import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { projectDeviceApi, dereference } from './compatibility.mjs';
const parse = (data) => JSON.parse(data);
export function snapshot(read = (path) => readFileSync(path, 'utf8')) {
  const version = parse(read('contracts/contract-version.json'));
  const mqtt = {};
  const catalog = parse(read('contracts/mqtt/topic-catalog.json'));
  const common = parse(read('contracts/mqtt/schemas/common.schema.json'));
  for (const { type } of catalog.topics) {
    const schema = parse(read(`contracts/mqtt/schemas/${type}.schema.json`));
    // Replace the sole external MQTT common ref with an internal definition before projection.
    const internal = parse(JSON.stringify(schema).replaceAll('common.schema.json#/', '#/common/'));
    internal.common = parse(JSON.stringify(common).replaceAll('#/$defs/', '#/common/$defs/'));
    const normalized = dereference(internal, internal);
    delete normalized.common;
    mqtt[type] = normalized;
  }
  return {
    contractVersion: version.contractVersion,
    decisionRegisterVersion: version.decisionRegisterVersion,
    rest: projectDeviceApi(parse(read('contracts/rest/openapi.bundle.json'))),
    mqtt,
    errorCodes: parse(read('contracts/rest/error-codes.json')).errorCodes.map(({ code, httpStatus }) => ({
      code,
      httpStatus,
    })),
  };
}
export function wireHash(snapshot) {
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical({ rest: snapshot.rest, mqtt: snapshot.mqtt, errorCodes: snapshot.errorCodes })))
    .digest('hex');
}
export async function checkBaselines() {
  const { compareBaselines, enforceGovernance } = await import('./compatibility.mjs');
  const current = snapshot();
  const approvals = parse(readFileSync('contracts/testing/compatibility-approvals.json', 'utf8'));
  const previous = parse(readFileSync(`contracts/testing/baselines/${approvals.fromContractVersion}.json`, 'utf8'));
  const frozen = parse(readFileSync(`contracts/testing/baselines/${approvals.toContractVersion}.json`, 'utf8'));
  if (wireHash(previous) !== approvals.fromWireSha256 || wireHash(frozen) !== approvals.toWireSha256)
    throw new Error('BASELINE_HASH_MISMATCH');
  if (current.contractVersion !== frozen.contractVersion || wireHash(current) !== wireHash(frozen))
    throw new Error('CONTRACT_CHANGED_UPDATE_VERSION_DECISION_AND_BASELINE');
  const changes = compareBaselines(previous, current);
  enforceGovernance(
    changes,
    approvals,
    parse(readFileSync('contracts/contract-version.json', 'utf8')),
    parse(readFileSync('contracts/decisions/decision-register.json', 'utf8')),
  );
  return {
    previousContractVersion: previous.contractVersion,
    currentContractVersion: current.contractVersion,
    status: changes.length ? 'APPROVED_BREAKING_UPGRADE' : 'COMPATIBLE',
    approvedBreakingChanges: changes,
  };
}
