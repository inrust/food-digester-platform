/** Independent QA-06 artifact scanner. Findings contain paths/rules, never leaked values. */
const keyPattern =
  /private[_-]?key|password(?:[_-]?hash)?|passcode|secret|token|verifier|credential|api[_-]?key|access[_-]?key|authorization|cookie|session|jwt/i;
const valuePatterns = [
  ['private-key', /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['bearer', /\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+/-]{8,}=*/i],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
  ['signed-url', /https?:\/\/[^\s"'<>]*(?:X-Amz-(?:Signature|Credential|Security-Token)|[?&]token)=[^\s"'<>]+/i],
];
export function scanSecurityArtifact(value, knownValues = []) {
  const findings = [];
  let inspectedNodes = 0;
  const seen = new WeakSet();
  function visit(item, path, key = '') {
    inspectedNodes++;
    if (item === null || item === undefined || item === '' || item === '[REDACTED]') return;
    if (keyPattern.test(key)) {
      findings.push({ path, rule: 'sensitive-field' });
      return;
    }
    if (typeof item === 'string') {
      for (const [rule, pattern] of valuePatterns) if (pattern.test(item)) findings.push({ path, rule });
      if (knownValues.some((secret) => secret && item.includes(secret))) findings.push({ path, rule: 'known-canary' });
    } else if (typeof item === 'object') {
      if (seen.has(item)) return;
      seen.add(item);
      for (const field of Object.getOwnPropertyNames(item)) visit(item[field], `${path}.${field}`, field);
    }
  }
  visit(value, '$');
  return { inspectedNodes, findings };
}
