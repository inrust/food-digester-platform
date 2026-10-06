import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const execute = promisify(execFile);
export function parseCurlMetrics(text) {
  const values = text.trim().split(/\s+/).map(Number);
  if (values.length !== 8 || values.some((n) => !Number.isFinite(n) || n < 0)) throw Error('INVALID_CURL_METRICS');
  const [status, sslVerifyResult, connections, dns, tcpEnd, tlsEnd, firstByte, total] = values;
  if (
    ![status, sslVerifyResult, connections].every(Number.isInteger) ||
    dns > tcpEnd ||
    tcpEnd > tlsEnd ||
    tlsEnd > firstByte ||
    firstByte > total
  )
    throw Error('INVALID_CURL_ORDER');
  const ms = (n) => Math.round(n * 1e6) / 1000;
  return {
    status,
    sslVerifyResult,
    connections,
    dnsMs: ms(dns),
    tcpMs: ms(tcpEnd - dns),
    tlsMs: ms(tlsEnd - tcpEnd),
    responseWaitMs: ms(firstByte - tlsEnd),
    bodyAfterFirstByteMs: ms(total - firstByte),
    totalMs: ms(total),
  };
}
export async function runCurlTransport({ run = execute, env = process.env } = {}) {
  const proxies = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy'];
  const environment = {
    proxyEnvironmentPresent: proxies.some((k) => !!env[k]),
    customCaEnvironmentPresent: ['CURL_CA_BUNDLE', 'SSL_CERT_FILE', 'SSL_CERT_DIR'].some((k) => !!env[k]),
  };
  const result = {
    task: 'QA-09',
    scope: 'INDEPENDENT_CURL_HTTP11_TLS_VERIFIED_UNAUTHENTICATED_GET',
    source: run === execute ? 'CURL_REAL_TARGET' : 'CONTROLLED_TEST_ONLY',
    startedAt: new Date().toISOString(),
    budget: { requests: 6, concurrency: 1, deadlineSeconds: 20, retries: 0 },
    environment,
    rows: [],
    p95Accepted: false,
    fullQa09Accepted: false,
  };
  if (environment.proxyEnvironmentPresent) return { ...result, gate: 'NOT_RUN', reason: 'PROXY_PATH_UNREVIEWED' };
  for (const mode of ['default', 'ipv4'])
    for (let index = 1; index <= 3; index++) {
      const args = [
        '-q',
        '--silent',
        '--show-error',
        '--http1.1',
        '--connect-timeout',
        '10',
        '--max-time',
        '20',
        '--output',
        '/dev/null',
        '--write-out',
        '%{http_code} %{ssl_verify_result} %{num_connects} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}',
        ...(mode === 'ipv4' ? ['--ipv4'] : []),
        'https://api.bio-nexa.com/api/v1/admin/contracts',
      ];
      try {
        const { stdout } = await run('curl', args, { timeout: 25000, maxBuffer: 4096 });
        const metrics = parseCurlMetrics(stdout);
        result.rows.push({
          mode,
          index,
          ...metrics,
          gate: metrics.status === 401 && metrics.sslVerifyResult === 0 && metrics.connections === 1 ? 'PASS' : 'FAIL',
        });
      } catch {
        result.rows.push({ mode, index, gate: 'FAIL', code: 'CURL_REQUEST_OR_METRICS_FAILED' });
      }
    }
  result.finishedAt = new Date().toISOString();
  result.gate = result.rows.length === 6 && result.rows.every((r) => r.gate === 'PASS') ? 'PASS' : 'PARTIAL';
  result.boundaries =
    'No credentials/body saved; normal certificate verification, curlrc disabled. Each fresh process has no shared connection/session; default and IPv4 may use the same route. CLI timings include native/OS/network and do not identify a network node or establish P95.';
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || process.argv.length !== 3) throw Error('OUTPUT_REQUIRED');
  const result = await runCurlTransport();
  const path = 'scripts/qa09-curl-transport-diagnostic.mjs',
    bytes = readFileSync(path);
  result.sources = [
    { path, sha256: createHash('sha256').update(bytes).digest('hex'), sourceBase64: bytes.toString('base64') },
  ];
  writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ gate: result.gate, requests: result.rows.length }));
  process.exitCode = result.gate === 'PASS' ? 0 : 1;
}
