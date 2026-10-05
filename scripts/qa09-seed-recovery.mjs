export function seedCleanupAction(observed, devices) {
  if (
    !Array.isArray(devices) ||
    devices.length !== 10 ||
    !Array.isArray(observed.devices) ||
    !Array.isArray(observed.certificates) ||
    !Array.isArray(observed.requests) ||
    ![0, 10].includes(observed.devices.length) ||
    observed.devices.some((d, i) => d.id !== devices[i] || d.serial_number !== d.id) ||
    (!observed.devices.length && (observed.certificates?.length || observed.requests?.length))
  )
    throw Error('UNKNOWN_PARTIAL_SEED_STATE');
  return observed.devices.length === 10 ? 'cleanup' : 'audit-empty';
}
