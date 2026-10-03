export function evaluateConnectionBudget({ ordinarySlots, operationalReserve, idleOverlapReserve, functions }) {
  if (
    !Number.isInteger(ordinarySlots) ||
    ordinarySlots < 1 ||
    !Number.isInteger(operationalReserve) ||
    operationalReserve < 1 ||
    !Number.isInteger(idleOverlapReserve) ||
    idleOverlapReserve < 1 ||
    !Array.isArray(functions) ||
    !functions.length
  )
    throw Error('EXPLICIT_CONNECTION_RESERVES_REQUIRED');
  if (
    new Set(functions.map((x) => x.name)).size !== functions.length ||
    functions.some(
      (x) =>
        !x.name ||
        !Number.isInteger(x.concurrency) ||
        x.concurrency < 1 ||
        !Number.isInteger(x.poolMax) ||
        x.poolMax < 1,
    )
  )
    throw Error('INVALID_FUNCTION_CONNECTION_BUDGET');
  const steadyConnections = functions.reduce((sum, x) => sum + x.concurrency * x.poolMax, 0);
  const requiredSlots = steadyConnections + operationalReserve + idleOverlapReserve;
  return {
    gate: requiredSlots <= ordinarySlots ? 'PASS' : 'FAIL',
    ordinarySlots,
    steadyConnections,
    operationalReserve,
    idleOverlapReserve,
    requiredSlots,
    headroom: ordinarySlots - requiredSlots,
    scope: 'PLANNING_ARITHMETIC_NOT_RUNTIME_CAPACITY_ACCEPTANCE',
  };
}
