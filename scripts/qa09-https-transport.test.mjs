import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, createServer, request } from 'node:http';
import { observedHttpsFetch } from './qa09-https-transport.mjs';
import { observeTargetHttp } from './qa09-http-observation.mjs';

test('socket events split DNS/TCP/TLS; receipts contain no URL, authorization or socket details', async () => {
  let now = 0;
  const req = new EventEmitter(),
    socket = new EventEmitter(),
    res = new EventEmitter();
  socket.connecting = true;
  res.statusCode = 200;
  res.headers = { 'x-amzn-requestid': 'own-id' };
  req.write = () => {};
  req.end = () =>
    queueMicrotask(() => {
      now = 3;
      req.emit('socket', socket);
      now = 8;
      socket.emit('lookup');
      now = 15;
      socket.emit('connect');
      now = 24;
      socket.emit('secureConnect');
      now = 25;
      req.emit('finish');
      now = 40;
      req.emit('response', res);
      now = 48;
      res.emit('data', Buffer.from('{"data":'));
      now = 59;
      res.emit('data', Buffer.from('1}'));
      res.emit('end');
    });
  const timing = {};
  const result = await observedHttpsFetch(
    'https://secret.invalid',
    { headers: { Authorization: 'Bearer SECRET_SENTINEL' } },
    timing,
    {
      requester: (_, options) => {
        assert.equal(options.agent.maxTotalSockets, 6);
        return req;
      },
      clock: () => now,
    },
  );
  assert.deepEqual(await result.json(), { data: 1 });
  assert.equal(timing.socketAcquisitionMs, 3);
  assert.equal(timing.dnsMs, 5);
  assert.equal(timing.tcpMs, 7);
  assert.equal(timing.tlsMs, 9);
  assert.equal(timing.responseWaitMs, 15);
  assert.equal(timing.bodyReadMs, 19);
  assert.equal(timing.phase, 'COMPLETE');
  assert.equal(JSON.stringify(timing).includes('SECRET_SENTINEL'), false);
  assert.equal(JSON.stringify(timing).includes('secret.invalid'), false);
});
async function local(t, handler) {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    agent.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    requester: (url, options) => request(url, { ...options, agent }),
  };
}
test('real delayed body is measured separately; a reused connection has absent DNS/TCP/TLS, not invented zeros', async (t) => {
  let finishBody;
  const fixture = await local(t, (_, res) => {
    finishBody = () => res.end('true}');
    setTimeout(() => {
      res.writeHead(200);
      res.write('{"ok":');
    }, 25);
  });
  const first = {},
    second = {};
  const response1 = await observedHttpsFetch(fixture.url, {}, first, fixture);
  setTimeout(finishBody, 35);
  assert.deepEqual(await response1.json(), { ok: true });
  assert.ok(first.headersAtMs >= 20);
  assert.ok(first.bodyReadMs >= 25);
  assert.equal(first.reusedSocket, false);
  const response2 = await observedHttpsFetch(fixture.url, {}, second, fixture);
  setTimeout(finishBody, 35);
  assert.deepEqual(await response2.json(), { ok: true });
  assert.equal(second.reusedSocket, true);
  for (const name of ['dnsMs', 'tcpMs', 'tlsMs']) assert.equal(second[name], null);
});
test('total deadline aborts an unfinished response body; no complete-body receipt or retry', async (t) => {
  let calls = 0;
  const fixture = await local(t, (_, res) => {
    calls++;
    res.writeHead(200);
    res.write('{"ok":');
  });
  const timing = {};
  const deadline = new AbortController();
  const response = await observedHttpsFetch(fixture.url, { signal: deadline.signal }, timing, fixture);
  deadline.abort(new DOMException('deadline', 'TimeoutError')); // Inject expiry after real headers; avoid CI timing races.
  await assert.rejects(response.json());
  assert.equal(calls, 1);
  assert.equal(timing.phase, 'READ_BODY');
  assert.equal(timing.bodyEndAtMs, undefined);
});
test('injected fetch cannot masquerade as detailed socket observation', async () => {
  let calls = 0;
  await assert.rejects(
    observeTargetHttp({
      url: 'https://example.invalid',
      method: 'GET',
      detailedTransport: true,
      fetcher: () => {
        calls++;
      },
    }),
    /DETAILED_TRANSPORT_FETCHER_FORBIDDEN/,
  );
  assert.equal(calls, 0);
});
