import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const hash = (b) => createHash('sha256').update(b).digest('hex');
const demand = (v, c) => {
  if (!v) throw Error(c);
};
export function partitionTransport(r) {
  const t = r.clientTransport;
  demand(t?.source === 'NODE_HTTPS_SOCKET_EVENTS' && typeof t.reusedSocket === 'boolean', 'HISTORY_TRANSPORT_SOURCE');
  for (const key of [
    'socketAcquisitionMs',
    'requestSentAtMs',
    'headersAtMs',
    'bodyEndAtMs',
    'bodyReadMs',
    'responseWaitMs',
    'jsonParseMs',
  ])
    demand(Number.isFinite(t[key]) && t[key] >= 0, 'HISTORY_TRANSPORT_TIMING');
  const ordered = ['socketAcquisitionMs', 'requestSentAtMs', 'headersAtMs', 'bodyEndAtMs'].map((k) => t[k]);
  demand(
    ordered.every((v, i) => i === 0 || v >= ordered[i - 1]),
    'HISTORY_TRANSPORT_ORDER',
  );
  demand(
    Math.abs(t.responseWaitMs - (t.headersAtMs - t.requestSentAtMs)) <= 2 &&
      Math.abs(t.bodyReadMs - (t.bodyEndAtMs - t.headersAtMs)) <= 2,
    'HISTORY_TRANSPORT_CONSERVATION',
  );
  demand(Number.isFinite(r.latencyMs) && r.latencyMs >= t.bodyEndAtMs - 2, 'HISTORY_TRANSPORT_TOTAL');
  for (const key of ['dnsMs', 'tcpMs', 'tlsMs'])
    demand(t[key] === null || (Number.isFinite(t[key]) && t[key] >= 0), 'HISTORY_NULL_IS_NOT_ZERO');
  // Disjoint client event intervals; TCP/TLS are overlapping detail, never added again.
  return {
    acquisitionMs: t.socketAcquisitionMs,
    acquisitionToSentMs: t.requestSentAtMs - t.socketAcquisitionMs,
    sentToHeadersMs: t.headersAtMs - t.requestSentAtMs,
    headersToEndMs: t.bodyEndAtMs - t.headersAtMs,
    endToClientCompletionMs: r.latencyMs - t.bodyEndAtMs,
    tcpMs: t.tcpMs,
    tlsMs: t.tlsMs,
    dnsMs: t.dnsMs,
    reusedSocket: t.reusedSocket,
    longTail: [t.tcpMs, t.tlsMs].some((v) => v !== null && v >= 1000),
  };
}
export function analyzeHistory(directory) {
  const root = resolve(directory),
    manifestBytes = readFileSync(root + '/manifest.json'),
    manifest = JSON.parse(manifestBytes);
  demand(
    manifest.seal === 'PASS' &&
      manifest.sourceCommit === '12d57befe55be1e1abfd1e226c2d13cbace992dc' &&
      manifest.gate === 'PARTIAL',
    'HISTORY_MANIFEST',
  );
  const checked = Object.entries(manifest.files);
  demand(checked.length === manifest.fileCount && checked.length === 833, 'HISTORY_FILE_COUNT');
  for (const [path, digest] of checked) {
    demand(!path.includes('..') && !path.startsWith('/'), 'HISTORY_PATH');
    demand(hash(readFileSync(root + '/' + path)) === digest, 'HISTORY_BINDING:' + path);
  }
  const groups = [],
    windows = [];
  const targetIds = { r0: '440b4178-a8f8-4569-bed8-878c9ce42f69', r1: 'c9a0c023-6160-4ae4-a6bd-3af15a6804de' };
  for (const mode of ['r0', 'r1']) {
    const rows = [],
      bindings = {};
    for (const name of ['baseline-patch.json', 'baseline-audit.json', 'sampling-patch.json', 'sampling-audit.json']) {
      const path = mode + '/' + name,
        data = readFileSync(root + '/' + path),
        receipt = JSON.parse(data);
      bindings[path] = hash(data);
      demand(receipt.gate === 'PASS' && receipt.sourceCommit === manifest.sourceCommit, 'HISTORY_SOURCE');
      for (const r of receipt.records) {
        demand(
          r.exactLinked &&
            r.lambda.length === 1 &&
            r.gateway.length === 1 &&
            r.lambda[0].gatewayRequestId === r.requestId &&
            r.gateway[0].integrationRequestId === r.lambda[0].lambdaRequestId,
          'HISTORY_REQUEST_LINK',
        );
        const partition = partitionTransport(r);
        rows.push({
          id: r.id,
          requestId: r.requestId,
          status: r.status,
          physicalCold: r.platformReports.some((p) => p.initDurationMs != null),
          clientMs: r.latencyMs,
          applicationMs: r.lambda[0].elapsedMs,
          responseWaitMinusApplicationMs: partition.sentToHeadersMs - r.lambda[0].elapsedMs,
          residualMeaning: 'CLOCKED_RESPONSE_WAIT_MINUS_NESTED_APPLICATION_NOT_NETWORK_NODE_TIME',
          partition,
        });
        if (r.requestId === targetIds[mode]) {
          demand(
            name === 'baseline-patch.json' &&
              r.status === 409 &&
              r.platformReports.some((p) => p.initDurationMs != null),
            'HISTORY_COLD_BASELINE',
          );
          const phases = r.phases.filter((p) =>
            [
              'contract-load-await-after-queue',
              'contract-load-driver-query',
              'contract-load-driver-submit',
              'contract-load-driver-await',
              'contract-load-pg-submit',
              'contract-load-pg-await',
              'contract-load-result-to-model',
              'contract-load-result-after-model',
            ].includes(p.phase),
          );
          demand(
            phases.length === 8 &&
              new Set(phases.map((p) => p.phase)).size === 8 &&
              phases.every(
                (p) =>
                  p.processCpuScope === 'PROCESS_ALL_THREADS' &&
                  Number.isFinite(p.processCpuUserUs) &&
                  Number.isFinite(p.processCpuSystemUs) &&
                  p.gatewayRequestId === r.requestId,
              ),
            'HISTORY_PHASE_SCOPE',
          );
          windows.push({
            mode,
            requestId: r.requestId,
            firstPhysicalCold: true,
            phases: phases.map((p) => ({
              phase: p.phase,
              wallMs: p.durationMs,
              processCpuMs: (p.processCpuUserUs + p.processCpuSystemUs) / 1000,
              processCpuScope: p.processCpuScope,
            })),
            caution: 'NESTED_PHASES_NOT_ADDITIVE_CPU_IS_ALL_THREADS_WALL_MINUS_CPU_IS_NOT_WAIT_TIME',
          });
        }
      }
    }
    demand(rows.length === 55 && new Set(rows.map((r) => r.requestId)).size === 55, 'HISTORY_REQUEST_COUNT');
    const tails = rows.filter((r) => r.partition.longTail);
    groups.push({
      mode,
      bindings,
      requestCount: rows.length,
      freshSockets: rows.filter((r) => !r.partition.reusedSocket).length,
      nullTcpCount: rows.filter((r) => r.partition.tcpMs === null).length,
      longTails: tails,
      maxTcpMs: Math.max(...rows.map((r) => r.partition.tcpMs ?? 0)),
      maxTlsMs: Math.max(...rows.map((r) => r.partition.tlsMs ?? 0)),
      rows,
    });
  }
  demand(windows.length === 2, 'HISTORY_BASELINE_COUNT');
  return {
    gate: 'PASS',
    scope: 'OFFLINE_REANALYSIS_OF_SEALED_TARGET_RECEIPTS',
    manifestSha256: hash(manifestBytes),
    sourceCommit: manifest.sourceCommit,
    verifiedHistoricalFiles: checked.length,
    externalDocumentBindings: 'HISTORICAL_SNAPSHOT_NOT_REBOUND_TO_CURRENT_TASKLIST',
    groups,
    windows,
    additionalRequests: 0,
    secondNetworkAvailable: false,
    networkNodeAttribution: 'UNRESOLVED',
    compilerOnlyAttribution: false,
    causeOf425ms: 'NOT_ESTABLISHED',
    p95Accepted: false,
    fullQa09Accepted: false,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || existsSync(process.argv[3])) throw Error('FRESH_HISTORY_OUTPUT_REQUIRED');
  const result = analyzeHistory(process.argv[2]);
  writeFileSync(process.argv[3], JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      gate: result.gate,
      verifiedFiles: result.verifiedHistoricalFiles,
      requests: result.groups.map((g) => g.requestCount),
      additionalRequests: 0,
    }),
  );
}
