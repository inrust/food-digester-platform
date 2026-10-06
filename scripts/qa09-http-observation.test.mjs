import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTargetHttp } from './qa09-http-observation.mjs';
test('request UUID is durable before a single dispatch and credentials never enter receipts', async () => {
  const events = [];
  const r = await observeTargetHttp({
    url: 'https://example.invalid',
    method: 'GET',
    headers: { Authorization: 'Bearer private-token' },
    onPrepared: (o) => events.push(o),
    fetcher: async (_, options) => {
      assert.equal(events.length, 1);
      assert.equal(options.headers['x-amzn-RequestId'], events[0].clientRequestId);
      return new Response(JSON.stringify({ data: {} }), { headers: { 'x-amzn-requestid': events[0].clientRequestId } });
    },
  });
  assert.equal(r.observation.transportPhase, 'COMPLETE');
  assert.equal(r.observation.headersReceived, true);
  assert.equal(r.observation.responseReceived, true);
  assert.equal(JSON.stringify([...events, r.observation]).includes('private-token'), false);
});
for (const phase of ['AWAIT_HEADERS', 'READ_BODY'])
  test('failed ' + phase + ' preserves correlation without retry', async () => {
    let calls = 0,
      failed;
    const error = Object.assign(Error('secret SQL'), { name: 'TimeoutError', cause: { code: 'UND_ERR_SOCKET' } });
    await assert.rejects(
      observeTargetHttp({
        url: 'https://example.invalid',
        method: 'PATCH',
        onFailure: (o) => {
          failed = o;
        },
        fetcher: async () => {
          calls++;
          if (phase === 'AWAIT_HEADERS') throw error;
          return {
            status: 200,
            headers: new Headers({ 'x-amzn-requestid': 'server-id' }),
            json: async () => {
              throw error;
            },
          };
        },
      }),
      (e) => e === error,
    );
    assert.equal(calls, 1);
    assert.equal(failed.transportPhase, phase);
    assert.equal(failed.headersReceived, phase === 'READ_BODY');
    assert.equal(failed.responseReceived, false);
    assert.equal(failed.causeCode, 'UND_ERR_SOCKET');
    assert.ok(failed.clientRequestId);
    assert.equal(JSON.stringify(failed).includes('secret SQL'), false);
  });
test('malformed JSON cannot become a successful HTTP receipt', async () => {
  let failed;
  await assert.rejects(
    observeTargetHttp({
      url: 'https://example.invalid',
      method: 'GET',
      onFailure: (o) => {
        failed = o;
      },
      fetcher: async () => new Response('invalid json'),
    }),
  );
  assert.equal(failed.status, 200);
  assert.equal(failed.responseReceived, false);
  assert.equal(failed.transportPhase, 'READ_BODY');
});
