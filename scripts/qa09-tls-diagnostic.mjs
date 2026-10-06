import { Agent, request } from 'node:https';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { observedHttpsFetch } from './qa09-https-transport.mjs';
const target = 'https://api.bio-nexa.com/api/v1/admin/contracts';
const durationFields = [
  'socketAcquisitionMs',
  'dnsMs',
  'tcpMs',
  'tlsMs',
  'requestSentAtMs',
  'headersAtMs',
  'responseWaitMs',
  'firstBodyAtMs',
  'bodyEndAtMs',
  'bodyReadMs',
  'jsonParseMs',
];
export async function probeTlsRequest(mode, index, sharedAgent) {
  const agent =
    mode === 'new-session'
      ? new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1, maxCachedSessions: 0 })
      : sharedAgent;
  const timing = {},
    tls = {};
  const requestId = randomUUID(),
    startedAt = new Date().toISOString(),
    start = performance.now();
  let status,
    gatewayRequestId,
    received = false,
    failure;
  try {
    const response = await observedHttpsFetch(
      target,
      {
        method: 'GET',
        headers: { 'x-amzn-RequestId': requestId, Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
        rejectUnauthorized: true,
      },
      timing,
      {
        requester: (url, options) => {
          const req = request(url, { ...options, agent });
          req.once('socket', (socket) => {
            const capture = () => {
              tls.authorized = socket.authorized === true;
              const protocol = socket.getProtocol();
              tls.protocol = ['TLSv1.2', 'TLSv1.3'].includes(protocol) ? protocol : null;
              const cipher = socket.getCipher()?.standardName;
              tls.cipher = typeof cipher === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(cipher) ? cipher : null;
              tls.sessionReused = socket.isSessionReused() === true;
            };
            if (!socket.connecting) capture();
            else socket.once('secureConnect', capture);
          });
          return req;
        },
      },
    );
    status = response.status;
    const id = response.headers.get('x-amzn-requestid');
    gatewayRequestId = id && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
    await response.json(); // Read fully, discard all payload/headers; no identity or business credentials.
    received = true;
  } catch (e) {
    failure = {
      name: /^[A-Za-z][A-Za-z0-9]{1,80}$/.test(e.name ?? '') ? e.name : 'TransportError',
      code: /^[A-Z][A-Z0-9_]{0,80}$/.test(e.code ?? '') ? e.code : 'TRANSPORT_FAILED',
    };
  } finally {
    if (mode === 'new-session') agent.destroy();
  }
  return {
    mode,
    index,
    requestId,
    gatewayRequestId,
    startedAt,
    status: status ?? null,
    responseReceived: received,
    latencyMs: Math.round(performance.now() - start),
    clientTransport: {
      source: timing.source,
      phase: timing.phase,
      reusedSocket: timing.reusedSocket,
      ...Object.fromEntries(
        durationFields
          .filter((k) => timing[k] === null || (Number.isFinite(timing[k]) && timing[k] >= 0))
          .map((k) => [k, timing[k]]),
      ),
    },
    tls,
    ...(failure ? { failure } : {}),
  };
}
export async function runTlsDiagnostic({ perform = probeTlsRequest } = {}) {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  const agent = new Agent({
    keepAlive: true,
    maxSockets: 6,
    maxTotalSockets: 6,
    maxFreeSockets: 6,
    maxCachedSessions: 100,
  });
  const rows = [];
  let active = 0,
    peak = 0;
  const one = async (mode, index) => {
    active++;
    peak = Math.max(peak, active);
    try {
      return await perform(mode, index, agent);
    } finally {
      active--;
    }
  };
  const receipt = {
    task: 'QA-09',
    scope: 'TLS_TRANSPORT_ONLY_UNAUTHENTICATED_GET_NO_WRITE',
    source: perform === probeTlsRequest ? 'NODE_HTTPS_REAL_TARGET' : 'CONTROLLED_TEST_ONLY',
    startedAt: new Date().toISOString(),
    gate: 'RUNNING',
    fullQa09Accepted: false,
    p95Accepted: false,
    budget: { requests: 12, maxConcurrency: 6, deadlineMs: 20000 },
    rows,
  };
  try {
    for (const mode of ['new-session', 'pooled']) for (let i = 1; i <= 3; i++) rows.push(await one(mode, i));
    const parallel = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => one('parallel', i + 1)));
    for (const result of parallel)
      if (result.status === 'fulfilled') rows.push(result.value);
      else receipt.orchestrationFailure = true;
  } finally {
    agent.destroy();
    histogram.disable();
  }
  const ms = (n) => (Number.isFinite(n) ? Math.round((n / 1e6) * 1000) / 1000 : null);
  receipt.eventLoop = {
    resolutionMs: 20,
    maxDelayMs: histogram.max > 0 ? ms(histogram.max) : null,
    meanDelayMs: histogram.count > 0 ? ms(histogram.mean) : null,
    samples: histogram.count,
  };
  receipt.peakConcurrency = peak;
  receipt.finishedAt = new Date().toISOString();
  receipt.gate =
    !receipt.orchestrationFailure &&
    rows.length === 12 &&
    peak <= 6 &&
    rows.every(
      (r) =>
        r.status === 401 &&
        r.responseReceived &&
        r.clientTransport.phase === 'COMPLETE' &&
        r.tls.authorized === true &&
        ['TLSv1.2', 'TLSv1.3'].includes(r.tls.protocol),
    )
      ? 'PASS'
      : 'PARTIAL';
  receipt.reuseComparisonGate =
    rows.filter((r) => r.mode === 'pooled' && r.index > 1).every((r) => r.clientTransport.reusedSocket === true) &&
    rows.filter((r) => r.mode === 'pooled').length === 3
      ? 'PASS'
      : 'NOT_OBSERVED';
  receipt.boundaries =
    'Independent unauthenticated reads; no SQL/write/load/P95 acceptance. Socket events include local scheduling and network; histogram is process-wide and does not isolate network nodes or prove TLS root cause. New-session disables cached sessions; pooled/parallel share a bounded agent with normal certificate verification. Missing phases remain absent/null.';
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || process.argv.length !== 3) throw Error('OUTPUT_REQUIRED');
  const result = await runTlsDiagnostic();
  result.sources = ['scripts/qa09-tls-diagnostic.mjs', 'scripts/qa09-https-transport.mjs'].map((path) => {
    const b = readFileSync(path);
    return { path, sha256: createHash('sha256').update(b).digest('hex'), sourceBase64: b.toString('base64') };
  });
  writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
  console.log(
    JSON.stringify({
      gate: result.gate,
      requests: result.rows.length,
      peakConcurrency: result.peakConcurrency,
      reuseComparisonGate: result.reuseComparisonGate,
    }),
  );
  process.exitCode = result.gate === 'PASS' ? 0 : 1;
}
