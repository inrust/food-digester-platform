/** A historical read/control proof cannot imply a write, another role or a changed domain. */
export function canReuseReadUi(e, allowedGroups, sourceCompatible, currentRealReadControl) {
  return (
    sourceCompatible === true &&
    currentRealReadControl === true &&
    e.result === 'PASS' &&
    allowedGroups.has(e.group) &&
    e.executions?.length === 2 &&
    new Set(e.executions.map((x) => x.width)).size === 2 &&
    e.executions.every(
      (x) =>
        [375, 1440].includes(x.width) &&
        x.result === 'PASS' &&
        x.role === 'PlatformSuperAdmin' &&
        x.requests?.length > 0 &&
        x.requests.every((q) => q.method === 'GET' && q.status === 200 && !!q.requestId),
    )
  );
}
