import { readFileSync } from 'node:fs';

export function dereference(document, value, stack = []) {
  if (Array.isArray(value)) return value.map((item) => dereference(document, item, stack));
  if (!value || typeof value !== 'object') return value;
  if (value.$ref) {
    if (!value.$ref.startsWith('#/')) throw new Error('UNBUNDLED_REFERENCE');
    if (stack.includes(value.$ref)) throw new Error('RECURSIVE_BASELINE_UNSUPPORTED');
    const target = value.$ref
      .slice(2)
      .split('/')
      .reduce((node, key) => node[key.replace(/~1/gu, '/').replace(/~0/gu, '~')], document);
    if (!target) throw new Error('MISSING_REFERENCE');
    return dereference(document, target, [...stack, value.$ref]);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !['description', 'title', 'summary', 'example', 'examples', 'default', '$schema', '$id'].includes(key) &&
          !key.startsWith('x-'),
      )
      .map(([key, child]) => [key, dereference(document, child, stack)]),
  );
}
export function projectDeviceApi(api) {
  const result = {};
  for (const [path, item] of Object.entries(api.paths)) {
    if (!path.startsWith('/api/v1/device/')) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!operation.operationId) continue;
      result[operation.operationId] = {
        path,
        method,
        security: operation.security ?? [],
        request: {
          body: operation.requestBody ? dereference(api, operation.requestBody) : null,
          parameters: dereference(api, [...(item.parameters ?? []), ...(operation.parameters ?? [])]),
        },
        responses: dereference(api, operation.responses),
      };
    }
  }
  return result;
}

/** Conservative schema comparison: unknown changed validation rules fail closed. Descriptions/examples do not matter. */
export function breakingChanges(before, after, path = '', direction = 'request') {
  const changes = [];
  const emit = (at, kind) => changes.push({ path: at, kind });
  if (before === null || after === null || typeof before !== 'object' || typeof after !== 'object') {
    if (JSON.stringify(before) !== JSON.stringify(after)) emit(path, 'constraint-changed');
    return changes;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    if (JSON.stringify(before) !== JSON.stringify(after)) emit(path, 'constraint-changed');
    return changes;
  }
  const oldProperties = before.properties ?? {};
  const newProperties = after.properties ?? {};
  for (const [key, schema] of Object.entries(oldProperties)) {
    if (!(key in newProperties)) emit(`${path}/properties/${key}`, 'field-removed');
    else changes.push(...breakingChanges(schema, newProperties[key], `${path}/properties/${key}`, direction));
  }
  if (direction === 'response' && before.additionalProperties === false) {
    for (const key of Object.keys(newProperties))
      if (!(key in oldProperties)) emit(`${path}/properties/${key}`, 'closed-response-field-added');
  }
  const oldRequired = before.required ?? [];
  const newRequired = after.required ?? [];
  if (Array.isArray(oldRequired) && Array.isArray(newRequired)) {
    const requiredChanges =
      direction === 'request'
        ? newRequired.filter((key) => !oldRequired.includes(key))
        : oldRequired.filter((key) => !newRequired.includes(key));
    for (const key of requiredChanges)
      emit(`${path}/required/${key}`, direction === 'request' ? 'request-required-added' : 'response-required-removed');
  } else if (before.required !== after.required) emit(`${path}/required`, 'body-required-changed');
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (['properties', 'required'].includes(key)) continue;
    if (!(key in after)) {
      emit(`${path}/${key}`, 'constraint-removed');
      continue;
    }
    if (!(key in before)) {
      emit(`${path}/${key}`, 'constraint-added');
      continue;
    }
    changes.push(...breakingChanges(before[key], after[key], `${path}/${key}`, direction));
  }
  return changes;
}
export function compareBaselines(before, after) {
  const changes = [];
  for (const [id, operation] of Object.entries(before.rest)) {
    const current = after.rest[id];
    if (!current) {
      changes.push({ path: `/rest/${id}`, kind: 'operation-removed' });
      continue;
    }
    for (const key of ['path', 'method', 'security'])
      changes.push(...breakingChanges(operation[key], current[key], `/rest/${id}/${key}`));
    changes.push(...breakingChanges(operation.request, current.request, `/rest/${id}/request`, 'request'));
    changes.push(...breakingChanges(operation.responses, current.responses, `/rest/${id}/responses`, 'response'));
  }
  for (const [type, schema] of Object.entries(before.mqtt)) {
    if (!after.mqtt[type]) changes.push({ path: `/mqtt/${type}`, kind: 'topic-schema-removed' });
    else changes.push(...breakingChanges(schema, after.mqtt[type], `/mqtt/${type}`, 'request'));
  }
  changes.push(...breakingChanges(before.errorCodes, after.errorCodes, '/errorCodes'));
  return changes.sort((a, b) => `${a.path}:${a.kind}`.localeCompare(`${b.path}:${b.kind}`));
}
export function enforceGovernance(changes, approvals, version, decisions) {
  const errors = [];
  for (const change of changes) {
    const approval = approvals.changes.find((item) => item.path === change.path && item.kind === change.kind);
    if (!approval) {
      errors.push(`UNAPPROVED_BREAK ${change.path} ${change.kind}`);
      continue;
    }
    if (
      approvals.toContractVersion !== version.contractVersion ||
      approvals.toContractVersion === approvals.fromContractVersion
    )
      errors.push('CONTRACT_VERSION_NOT_UPDATED');
    const [id, decisionVersion] = approval.decision.split('@');
    const decision = decisions.decisions.find((item) => item.id === id);
    if (
      !decision ||
      decision.status !== 'frozen' ||
      decision.version !== decisionVersion ||
      !decision.history.some((item) => item.version === decisionVersion)
    )
      errors.push(`DECISION_NOT_FROZEN ${approval.decision}`);
  }
  for (const approval of approvals.changes)
    if (!changes.some((change) => change.path === approval.path && change.kind === approval.kind))
      errors.push(`STALE_APPROVAL ${approval.path}`);
  if (version.decisionRegisterVersion !== decisions.registerVersion) errors.push('DECISION_REGISTER_VERSION_MISMATCH');
  if (errors.length) throw new Error(errors.join('\n'));
}
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
