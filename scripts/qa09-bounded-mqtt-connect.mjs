/** MQTT.js connectAsync can remain unsettled when an inactive certificate closes before CONNACK. */
export function observeMqttConnect(connect, url, options, deadlineMs = 15000) {
  if (
    options.rejectUnauthorized !== true ||
    options.reconnectPeriod !== 0 ||
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 15000
  )
    throw Error('BOUNDED_VERIFIED_TLS_WITHOUT_RECONNECT_REQUIRED');
  return new Promise((resolve, reject) => {
    let client,
      timer,
      settled = false;
    const finish = (outcome, code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (outcome !== 'CONNECTED') client.end(true);
      resolve({ outcome, errorCode: code, ...(outcome === 'CONNECTED' ? { client } : {}) });
    };
    try {
      client = connect(url, options);
    } catch {
      reject(Error('MQTT_CONNECT_START_FAILED'));
      return;
    }
    client.on('error', (e) => {
      const code = typeof e.code === 'number' ? e.code : /^[A-Z0-9_]{1,50}$/.test(e.code ?? '') ? e.code : null;
      if (code === 5 || /not authorized/i.test(e.message ?? '')) finish('NOT_AUTHORIZED', code);
      else if (code === 'ECONNRESET') finish('CONNECTION_RESET', code);
      else finish('TRANSPORT_FAILURE', code);
    });
    client.once('connect', () => finish('CONNECTED'));
    client.once('close', () => finish('CLOSED_BEFORE_CONNACK'));
    timer = setTimeout(() => finish('DEADLINE_WITHOUT_CONNECTION_PROOF'), deadlineMs);
  });
}
export function oldMqttDenial(outcome, iotStatus, adjacentNewControl) {
  if (iotStatus !== 'INACTIVE' || adjacentNewControl !== true)
    throw Error('INACTIVE_IDENTITY_AND_ADJACENT_VALID_CONTROL_REQUIRED');
  if (outcome === 'NOT_AUTHORIZED') return 'NOT_AUTHORIZED';
  if (['CLOSED_BEFORE_CONNACK', 'CONNECTION_RESET'].includes(outcome))
    return 'NO_CONNACK_WITH_INACTIVE_CERT_AND_ADJACENT_VALID_CONTROL';
  throw Error('OLD_MQTT_DENIAL_NOT_PROVEN');
}
