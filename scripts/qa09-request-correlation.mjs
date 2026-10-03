export function correlateGatewayRequest(client, rows) {
  if (
    !client.gatewayExtendedRequestId ||
    !client.gatewayRequestId ||
    !Number.isFinite(Date.parse(client.startedAt)) ||
    !Number.isFinite(client.latencyMs)
  )
    return { gate: 'NOT_PROVABLE', reason: 'CLIENT_REQUEST_CORRELATION_FIELDS_MISSING' };
  const matches = rows.filter(
    (x) => x.extendedRequestId === client.gatewayExtendedRequestId && x.requestId === client.gatewayRequestId,
  );
  if (matches.length !== 1) return { gate: 'NOT_PROVABLE', reason: 'EXACT_ACCESS_ROW_MISSING_OR_DUPLICATED' };
  const row = matches[0],
    requestTime = Number(row.requestTimeEpoch),
    started = Date.parse(client.startedAt);
  if (
    !Number.isFinite(requestTime) ||
    requestTime < started - 2000 ||
    requestTime > started + client.latencyMs + 2000 ||
    Number(row.status) !== client.status
  )
    return { gate: 'FAIL', reason: 'TIME_OR_STATUS_BINDING_MISMATCH' };
  const status = Number(row.integrationStatus),
    functionStatus = Number(row.functionResponseStatus);
  if (client.status === 500 && status === 429)
    return { gate: 'PASS', cause: 'LAMBDA_INVOCATION_SERVICE_429', lambdaInvocationRefused: true };
  if (client.status === 500 && status === 200 && functionStatus === 500)
    return { gate: 'PASS', cause: 'FUNCTION_RETURNED_500', lambdaInvocationRefused: false };
  return { gate: 'PARTIAL', cause: 'OTHER_OR_MISSING_INTEGRATION_STATUS' };
}
