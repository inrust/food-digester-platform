/** Shared writer order: device -> immutable trigger -> session(s). */
import type { DbClient } from '@fdp/database';

export async function lockMediaDevice(tx: DbClient, deviceId: string): Promise<void> {
  await tx.$queryRawUnsafe('SELECT id FROM devices WHERE id = $1 FOR UPDATE', deviceId);
}

export async function lockMediaTrigger(tx: DbClient, triggerId: string): Promise<void> {
  // Compatible with the declaration guard's FK/KEY SHARE read.
  await tx.$queryRawUnsafe('SELECT id FROM media_triggers WHERE id = $1 FOR NO KEY UPDATE', triggerId);
}

export async function lockMediaSession(tx: DbClient, sessionId: string): Promise<void> {
  await tx.$queryRawUnsafe('SELECT id FROM media_upload_sessions WHERE id = $1 FOR UPDATE', sessionId);
}
