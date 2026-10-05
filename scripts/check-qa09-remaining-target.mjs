import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
import { ROLES } from './qa09-business-target.mjs';
export function validateRemainingScope(child, parent, domain) {
  if (
    child.coreMode !== 'FIVE_ROLE_SCOPE_AND_ASSIGNMENT_FOUNDATION_NOT_FULL_CORE' ||
    child.nonActiveOnly !== true ||
    child.fullQa09Accepted !== false ||
    child.stages.foundation !== 'PASS' ||
    child.stages.remaining !== 'PASS' ||
    child.remaining?.gate !== 'PASS'
  )
    throw Error('REMAINING_SCOPE_NOT_PASSED');
  if (child.licenseLifecycle && child.licenseLifecycle.gate !== 'NOT_RUN') throw Error('ACTIVE_PROOF_FORBIDDEN');
  if (
    !child.finishedAt ||
    !child.cleanupComplete ||
    child.gate !== 'PASS' ||
    child.checks.some((c) => c.result === 'FAIL' || c.path?.endsWith('/activate'))
  )
    throw Error('TARGET_OR_CLEANUP_NOT_PASSED');
  if (
    !parent.finishedAt ||
    parent.gate !== 'PASS' ||
    !parent.cleanup.length ||
    parent.cleanup.some((c) => c.result !== 'PASS') ||
    domain.gate !== 'PASS' ||
    parent.prefix !== child.prefix ||
    domain.prefix !== child.prefix ||
    parent.sourceCommit !== child.sourceCommit
  )
    throw Error('PARENT_CLEANUP_NOT_PASSED');
  for (const role of ROLES) {
    const own = child.checks.find((c) => c.id === role + ':device-scope:0');
    const cross = child.checks.find((c) => c.id === role + ':device-scope:1');
    if (own?.status !== 200 || cross?.status !== (role.startsWith('Customer') ? 403 : 200))
      throw Error('FIVE_ROLE_SCOPE_MISSING');
  }
  return {
    gate: 'PASS',
    scope: child.remaining.scope,
    fullQa09Accepted: false,
    foundationOnly: true,
    legacyLifecycleMetadataMissing: child.licenseLifecycle === undefined,
    originalReceiptsPreserved: true,
  };
}
const hash = (b) => createHash('sha256').update(b).digest('hex');
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, version, output] = process.argv.slice(2);
  if (!input || !version || !output) throw Error('INPUT_VERSION_OUTPUT_REQUIRED');
  const read = (p) => JSON.parse(readFileSync(p));
  const child = read(input),
    parent = read(input + '.fixtures.json'),
    domain = read(input + '.domain-cleanup.json');
  validateBusinessVersion(read(version), child.sourceCommit);
  validateBusinessDatabaseReceipts(
    child,
    child.databaseBuilds.map((d) => read(d.receipt)),
  );
  if (domain.parentReceiptSha256 !== hash(readFileSync(input + '.fixtures.json')))
    throw Error('DOMAIN_PARENT_BINDING_MISSING');
  const result = {
    ...validateRemainingScope(child, parent, domain),
    sourceCommit: child.sourceCommit,
    prefix: child.prefix,
    checkedAt: new Date().toISOString(),
    checkerSha256: hash(readFileSync(new URL(import.meta.url))),
    receipts: [input, input + '.fixtures.json', input + '.domain-cleanup.json', version].map((path) => ({
      path,
      sha256: hash(readFileSync(path)),
    })),
  };
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
