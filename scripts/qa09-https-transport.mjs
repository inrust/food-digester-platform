import { Agent, request } from 'node:https';
// Six sockets bound this QA process; no service/pool budget changes or transport retries.
const agent = new Agent({ keepAlive: true, maxSockets: 6, maxTotalSockets: 6, maxFreeSockets: 6 });
export function observedHttpsFetch(
  url,
  options,
  timing,
  { requester = request, clock = () => performance.now() } = {},
) {
  const start = clock();
  const elapsed = () => Math.max(0, Math.round(clock() - start));
  Object.assign(timing, {
    source: 'NODE_HTTPS_SOCKET_EVENTS',
    phase: 'SOCKET_QUEUE',
    reusedSocket: false,
    dnsMs: null,
    tcpMs: null,
    tlsMs: null,
  });
  return new Promise((resolve, reject) => {
    const req = requester(url, {
      ...options,
      agent,
      headers: {
        ...options.headers,
        ...(options.body === undefined ? {} : { 'Content-Length': Buffer.byteLength(options.body) }),
      },
    });
    let socketAt, lookupAt, connectAt;
    req.once('socket', (socket) => {
      socketAt = clock();
      timing.socketAcquisitionMs = elapsed();
      timing.reusedSocket = req.reusedSocket === true;
      timing.phase = timing.reusedSocket ? 'AWAIT_HEADERS' : 'DNS_OR_TCP';
      if (!socket.connecting) return;
      // Listeners belong to this connection only; reused sockets never acquire new listeners.
      socket.once('lookup', () => {
        lookupAt = clock();
        timing.dnsMs = Math.max(0, Math.round(lookupAt - socketAt));
        timing.phase = 'TCP_CONNECT';
      });
      socket.once('connect', () => {
        connectAt = clock();
        timing.tcpMs = Math.max(0, Math.round(connectAt - (lookupAt ?? socketAt)));
        timing.phase = 'TLS_HANDSHAKE';
      });
      socket.once('secureConnect', () => {
        timing.tlsMs = connectAt === undefined ? null : Math.max(0, Math.round(clock() - connectAt));
        timing.phase = 'AWAIT_HEADERS';
      });
    });
    req.once('finish', () => {
      timing.requestSentAtMs = elapsed();
    });
    req.once('error', reject);
    req.once('response', (res) => {
      timing.headersAtMs = elapsed();
      timing.responseWaitMs = Math.max(0, timing.headersAtMs - (timing.requestSentAtMs ?? timing.headersAtMs));
      timing.phase = 'READ_BODY';
      const chunks = [];
      let resolveBody, rejectBody;
      const body = new Promise((a, b) => {
        resolveBody = a;
        rejectBody = b;
      });
      // Attach immediately: body errors can precede the caller's json() invocation.
      body.catch(() => {});
      res.on('data', (chunk) => {
        timing.firstBodyAtMs ??= elapsed();
        chunks.push(Buffer.from(chunk));
      });
      res.once('error', rejectBody);
      res.once('aborted', () => rejectBody(Object.assign(Error('RESPONSE_ABORTED'), { code: 'RESPONSE_ABORTED' })));
      res.once('end', () => {
        timing.bodyEndAtMs = elapsed();
        timing.bodyReadMs = timing.bodyEndAtMs - timing.headersAtMs;
        resolveBody(Buffer.concat(chunks));
      });
      resolve({
        status: res.statusCode,
        headers: new Headers(
          Object.entries(res.headers).flatMap(([k, v]) =>
            v === undefined ? [] : [[k, Array.isArray(v) ? v.join(',') : v]],
          ),
        ),
        async json() {
          const bytes = await body;
          const parseAt = clock();
          timing.phase = 'PARSE_JSON';
          try {
            const result = JSON.parse(bytes.toString('utf8'));
            timing.phase = 'COMPLETE';
            return result;
          } finally {
            timing.jsonParseMs = Math.max(0, Math.round(clock() - parseAt));
          }
        },
      });
    });
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}
