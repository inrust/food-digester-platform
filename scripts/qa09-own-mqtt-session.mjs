import { assertBusinessContext } from './qa09-business-target.mjs';
export async function withFreshOwnMqttSession(ctx, run, connect) {
  assertBusinessContext(ctx.receipt);
  const id = ctx.receipt.devices[0],
    held = ctx.held.get(id);
  if (!held?.cert || !held.key || !held.endpoint) throw Error('OWN_DEVICE_CERTIFICATE_REQUIRED');
  const connector = connect ?? (await import('mqtt')).connectAsync;
  const client = await connector('mqtts://' + held.endpoint + ':8883', {
    clientId: id,
    cert: held.cert,
    key: held.key,
    rejectUnauthorized: true,
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 0,
    connectTimeout: 15000,
  });
  client.on('error', () => {});
  try {
    return await run(client);
  } finally {
    await client.endAsync(true);
  }
}
