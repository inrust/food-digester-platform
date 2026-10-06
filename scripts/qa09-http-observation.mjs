import { observedHttpsFetch } from './qa09-https-transport.mjs';
import { randomUUID } from 'node:crypto';
const safe = (v) => (typeof v === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(v) ? v : null);
/** Single dispatch, no retries. UUID is persisted before fetch, including unknown outcomes. */
export async function observeTargetHttp({
  url,
  method,
  headers = {},
  body,
  timeoutMs = 20000,
  fetcher,
  detailedTransport = false,
  onPrepared = () => {},
  onFailure = () => {},
}) {
  if (detailedTransport && fetcher) throw Error('DETAILED_TRANSPORT_FETCHER_FORBIDDEN');
  const clientRequestId = headers['x-amzn-RequestId'] ?? randomUUID();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(clientRequestId))
    throw Error('INVALID_CLIENT_REQUEST_ID');
  const observation = {
    clientRequestId,
    method,
    startedAt: new Date().toISOString(),
    headersReceived: false,
    responseReceived: false,
    transportPhase: 'AWAIT_HEADERS',
  };
  const timing = {};
  if (detailedTransport) observation.clientTransport = timing;
  onPrepared({ ...observation, ...(detailedTransport ? { clientTransport: { ...timing } } : {}) });
  const start = performance.now();
  let res;
  try {
    res = await (fetcher ?? (detailedTransport ? (u, o) => observedHttpsFetch(u, o, timing) : fetch))(url, {
      method,
      headers: { ...headers, 'x-amzn-RequestId': clientRequestId },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    Object.assign(observation, {
      headersReceived: true,
      status: res.status,
      headersLatencyMs: Math.round(performance.now() - start),
      gatewayRequestId: res.headers.get('x-amzn-requestid'),
      gatewayExtendedRequestId: res.headers.get('x-amz-apigw-id'),
      gatewayErrorType: res.headers.get('x-amzn-errortype'),
      transportPhase: 'READ_BODY',
    });
    const data = await res.json();
    Object.assign(observation, {
      responseReceived: true,
      transportPhase: 'COMPLETE',
      completedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start),
      ...(detailedTransport ? { clientTransport: { ...timing } } : {}),
    });
    return { data, observation };
  } catch (e) {
    Object.assign(observation, {
      completedAt: new Date().toISOString(),
      latencyMs: Math.round(performance.now() - start),
      ...(detailedTransport ? { clientTransport: { ...timing } } : {}),
      errorName: safe(e?.name),
      causeCode: safe(e?.cause?.code ?? e?.code),
    });
    onFailure({ ...observation });
    throw e;
  }
}
