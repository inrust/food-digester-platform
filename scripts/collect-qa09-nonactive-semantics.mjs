import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { legalWriteInventory } from './qa09-legal-write-inventory.mjs';
import { semanticSummary, validateOwnCsv } from './qa09-nonactive-browser.mjs';
import { validateBusinessVersion, validateBusinessDatabaseReceipts } from './check-qa09-business-target.mjs';
const hash = (b) => createHash('sha256').update(b).digest('hex');
export function entityRows(receipt, parent) {
  if (
    receipt.gate !== 'PASS' ||
    receipt.cleanupVerified !== true ||
    !receipt.finishedAt ||
    !/^qa09-[a-f0-9]{16}$/.test(receipt.prefix) ||
    receipt.prefix !== parent.prefix ||
    receipt.sourceCommit !== parent.sourceCommit ||
    parent.gate !== 'PASS' ||
    !parent.finishedAt ||
    !parent.cleanup?.length ||
    parent.cleanup.some((x) => x.result !== 'PASS') ||
    !parent.cleanup.some((x) => x.type === 'database-fixtures' && x.count === 10) ||
    receipt.fullQa09Accepted !== false ||
    receipt.apiMock !== false
  )
    throw Error('ENTITY_RECEIPT_OR_CLEANUP_REQUIRED');
  const csr = receipt.scope === 'REAL_NONACTIVE_ENTITY_CSR',
    cert = receipt.scope === 'REAL_NONACTIVE_ENTITY_CERTIFICATE';
  if (!csr && !cert) throw Error('ENTITY_SCOPE_REQUIRED');
  if (
    !Array.isArray(receipt.layouts) ||
    receipt.layouts.length !== (csr ? 4 : 2) ||
    receipt.layouts.some(
      (x) =>
        ![375, 1440].includes(x.width) ||
        x.viewport !== x.width ||
        !Number.isFinite(x.document) ||
        !Number.isFinite(x.body) ||
        x.result !== 'PASS' ||
        Math.max(x.document, x.body) > x.width + 1,
    ) ||
    [375, 1440].some((width) => receipt.layouts.filter((x) => x.width === width).length !== (csr ? 2 : 1))
  )
    throw Error('ENTITY_VIEWPORT_LAYOUT_REQUIRED');
  if (csr && (parent.reviewOnly !== true || parent.scope !== 'PENDING_CSR_ENTITY_REVIEW_ONLY'))
    throw Error('CSR_REVIEW_SCOPE_REQUIRED');
  if (cert && (parent.reviewOnly !== false || parent.scope !== 'TEN_DEVICE_CSR_MTLS_HEARTBEAT_TELEMETRY_ARCHIVE'))
    throw Error('REAL_CERTIFICATE_WAVE_REQUIRED');
  const group = csr ? 'device-group.onboarding' : 'device-manage.certificate';
  if (
    receipt.executions.length !== (csr ? 4 : 2) ||
    receipt.executions.some(
      (x) => x.group !== group || x.result !== 'PASS' || !parent.devices.includes(x.deviceId) || !x.gatewayRequestId,
    )
  )
    throw Error('ENTITY_EXECUTIONS_REQUIRED');
  return [375, 1440].map((width) => {
    const proofs = receipt.executions.filter((x) => x.width === width);
    if (
      csr
        ? proofs.length !== 2 ||
          ['approve', 'reject'].some(
            (decision) => !proofs.some((x) => x.decision === decision && x.ifMatch && x.version > Number(x.ifMatch)),
          )
        : proofs.length !== 1 || proofs.some((x) => !x.rotationRequestId || !x.certificateId)
    )
      throw Error('ENTITY_BOTH_VIEWPORT_DECISIONS_REQUIRED');
    return { group, width, result: 'PASS', prefix: receipt.prefix, proofs };
  });
}
export function collectNonActive(root) {
  const read = (file) => JSON.parse(readFileSync(file));
  const refs = [];
  const bind = (file) => {
    const bytes = readFileSync(file);
    refs.push({ path: file, sha256: hash(bytes) });
    return JSON.parse(bytes);
  };
  const version = bind(root + '/application-version.json');
  validateBusinessVersion(version, version.sourceCommit);
  const data = bind(root + '/business.json'),
    browser = bind(root + '/business.json.browser.json'),
    gate = bind(root + '/business.json.gate.json');
  const executed = bind(root + '/business.json.sources.json').sources;
  if (
    !Array.isArray(executed) ||
    executed.some((s) => hash(Buffer.from(s.sourceBase64, 'base64')) !== s.sha256) ||
    !browser.sources?.length ||
    browser.sources.some(
      (s) =>
        hash(Buffer.from(s.sourceBase64, 'base64')) !== s.sha256 ||
        executed.find((x) => x.path === s.path)?.sha256 !== s.sha256,
    )
  )
    throw Error('BROWSER_EXECUTED_SOURCE_BINDING_REQUIRED');
  if (
    gate.cleanup !== 'PASS' ||
    !['PASS', 'PARTIAL'].includes(gate.gate) ||
    browser.sourceCommit !== version.sourceCommit ||
    browser.prefix !== data.prefix ||
    browser.gate === 'FAIL' ||
    browser.layoutGate !== 'PASS'
  )
    throw Error('DATA_TARGET_OR_LAYOUT_REQUIRED');
  validateBusinessDatabaseReceipts(
    data,
    data.databaseBuilds.map((b) => bind(b.receipt)),
  );
  if (
    browser.dataFixture?.fixtureMode !== 'SYNTHETIC_RDS_READ_MODELS_NO_DEVICE_INGESTION_OR_AUTH_CLAIM' ||
    browser.dataScope.length !== 6 ||
    browser.dataScope.some((x) => x.result !== 'PASS') ||
    browser.exports.length !== 6 ||
    browser.exports.some((x) => x.result !== 'PASS' || x.dataRows !== 1 || !x.ownRowsVerified)
  )
    throw Error('SYNTHETIC_DATA_AND_EXPORT_PROOF_REQUIRED');
  for (const e of browser.exports) {
    const bytes = readFileSync(e.csvReceipt);
    if (hash(bytes) !== e.sha256) throw Error('DOWNLOADED_CSV_HASH_MISMATCH');
    validateOwnCsv(bytes, e.kind === 'activity' ? data.prefix : data.devices[0]);
    refs.push({ path: e.csvReceipt, sha256: hash(bytes) });
  }
  const rows = [...browser.executions];
  const legalChecks = [...data.checks, ...browser.exports];
  const prefixes = [browser.prefix];
  for (const mode of ['csr', 'certificate']) {
    const receipt = bind(root + '/' + mode + '.json'),
      parent = bind(receipt.parentReceipt);
    if (
      receipt.parentReceiptSha256 !== hash(readFileSync(receipt.parentReceipt)) ||
      receipt.sourceCommit !== version.sourceCommit
    )
      throw Error('ENTITY_PARENT_OR_VERSION_NOT_BOUND');
    const sources = bind(root + '/' + mode + '.json.sources.json');
    if (
      !sources.sources?.length ||
      sources.sources.some((s) => hash(Buffer.from(s.sourceBase64, 'base64')) !== s.sha256)
    )
      throw Error('ENTITY_SOURCE_BYTES_REQUIRED');
    for (const row of entityRows(receipt, parent)) {
      const index = rows.findIndex((x) => x.group === row.group && x.width === row.width);
      if (index < 0) throw Error('UNKNOWN_ENTITY_GROUP');
      rows[index] = row;
    }
    legalChecks.push(
      ...parent.checks,
      ...receipt.executions.map((e) => ({
        ...e,
        status: e.httpStatus ?? e.status,
        requestId: e.httpRequestId ?? e.requestId,
      })),
    );
    prefixes.push(receipt.prefix);
  }
  if (new Set(prefixes).size !== 3) throw Error('INDEPENDENT_FIXTURE_PREFIXES_REQUIRED');
  const matrix = read('contracts/prototype-traceability.yaml');
  const result = semanticSummary(matrix, rows);
  const required = [
    'device-view.console',
    'device-operate.activities',
    'esg-overview.columns',
    'esg-device.metrics',
    'esg-overview.export',
    'esg-device.export',
    'device-group.onboarding',
    'device-manage.certificate',
  ];
  if (rows.some((x) => required.includes(x.group) && x.result !== 'PASS') || result.counts.FAIL)
    throw Error('REMAINING_NONACTIVE_PROOF_FAILED');
  return {
    task: 'QA-09',
    scope: 'SAME_APPLICATION_VERSION_MULTI_FIXTURE_NONACTIVE_SEMANTICS',
    sourceCommit: version.sourceCommit,
    prefixes,
    fullQa09Accepted: false,
    scopeGate: 'PASS',
    gate: result.gate,
    cleanup: 'PASS',
    legalWrites: legalWriteInventory(legalChecks),
    dataProvenance: 'SYNTHETIC_RDS_READ_MODELS_NOT_DEVICE_INGESTION',
    receipts: refs,
    ...result,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [root, output] = process.argv.slice(2);
  if (!root || !output) throw Error('ROOT_AND_OUTPUT_REQUIRED');
  const result = collectNonActive(root);
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ scopeGate: result.scopeGate, gate: result.gate, counts: result.counts }));
}
