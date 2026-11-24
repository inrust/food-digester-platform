export function isVerifiedClientVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && value.length > 0 && value.trim() === value;
}

/** Only an exact device ID and a verified client build can be admitted. Invalid configuration admits no devices. */
export function parseVerifiedDeviceClientTargets(raw: string | undefined): ReadonlyMap<string, string> {
  if (!raw) return new Map();
  try {
    const targets: unknown = JSON.parse(raw);
    if (targets === null || typeof targets !== 'object' || Array.isArray(targets)) return new Map();
    const entries = Object.entries(targets);
    if (
      entries.some(
        ([deviceId, version]) => !/^[a-zA-Z0-9_.:-]{1,128}$/.test(deviceId) || !isVerifiedClientVersion(version),
      )
    ) {
      return new Map();
    }
    return new Map(entries as [string, string][]);
  } catch {
    return new Map();
  }
}
