/** CT-05 HTTP envelope, deliberately distinct from the internal service Page object. */
export function readEsgList(response, { deviceId, customerId }) {
  if (
    !/^qa09-[a-f0-9]{16}-(0[1-9]|10)$/.test(deviceId ?? '') ||
    !/^[a-f0-9-]{36}$/.test(customerId ?? '') ||
    !Array.isArray(response?.data) ||
    response.data.length > 100 ||
    response.meta?.nextCursor !== null ||
    typeof response.meta?.requestId !== 'string' ||
    !response.meta.requestId ||
    !Number.isFinite(Date.parse(response.meta?.timestamp)) ||
    response.data.some((row) => row?.deviceId !== deviceId || row?.customerId !== customerId)
  )
    throw Error('BOUNDED_EXACT_ESG_HTTP_RESPONSE_REQUIRED');
  return response.data;
}
