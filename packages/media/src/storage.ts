/** BE-MED-01 Media 对象存储读取端口。 */
export interface MediaObjectStorage {
  readonly statObject: (key: string) => Promise<{ readonly sizeBytes: number } | null>;
  readonly computeSha256: (key: string) => Promise<string | null>;
}

export function buildMediaObjectKey(input: {
  readonly customerId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly fileName: string;
}): string {
  return `media/${input.customerId}/${input.deviceId}/${input.sessionId}/${input.fileName}`;
}

export function parseMediaObjectKey(
  key: string,
): { customerId: string; deviceId: string; sessionId: string; fileName: string } | null {
  const parts = key.split('/');
  if (parts.length !== 5 || parts[0] !== 'media') return null;
  const [customerId, deviceId, sessionId, fileName] = [parts[1]!, parts[2]!, parts[3]!, parts[4]!];
  if (!customerId || !deviceId || !sessionId || !fileName) return null;
  return { customerId, deviceId, sessionId, fileName };
}
