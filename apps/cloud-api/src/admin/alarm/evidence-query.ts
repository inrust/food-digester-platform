/** IMG-13: project linked image metadata only after both source and media authorization. */
import type { ActorContext } from '@fdp/auth';
import { hasPermission, requirePermission } from '@fdp/auth';
import type { DbClient } from '@fdp/database';
import type { EvidenceImage } from '@fdp/contracts/rest/image-types.js';

export type EvidenceImageView = EvidenceImage;

interface EvidenceSource {
  readonly id: string;
  readonly customerId: string;
  readonly deviceId: string;
  readonly sourceMessageId: string | null;
}

/** Undefined means omit; an authorized source without a valid LINKED image maps to null. */
export async function readEvidenceImages(
  client: DbClient,
  actor: ActorContext,
  kind: 'ALARM' | 'EVENT',
  sources: readonly EvidenceSource[],
): Promise<ReadonlyMap<string, EvidenceImageView | null> | undefined> {
  requirePermission(actor, 'alarm:read');
  if (!actor.roles.some((role) => hasPermission(role, 'media:read'))) return undefined;
  const result = new Map<string, EvidenceImageView | null>(sources.map((source) => [source.id, null]));
  const eligible = sources.filter(
    (source) => source.sourceMessageId && (actor.actorType === 'platform' || source.customerId === actor.customerId),
  );
  if (!eligible.length) return result;
  const byId = new Map(eligible.map((source) => [source.id, source]));
  const images = await client.mediaEvidence.findMany({
    where: {
      kind,
      status: 'LINKED',
      OR: eligible.map((source) => ({
        ...(kind === 'ALARM' ? { alarmId: source.id } : { eventId: source.id }),
        customerId: source.customerId,
        deviceId: source.deviceId,
        messageId: source.sourceMessageId!,
      })),
    },
    select: {
      alarmId: true,
      eventId: true,
      mediaId: true,
      customerId: true,
      deviceId: true,
      messageId: true,
      media: {
        select: { id: true, customerId: true, deviceId: true, mediaType: true, captureTime: true, status: true },
      },
    },
  });
  for (const evidence of images) {
    const sourceId = kind === 'ALARM' ? evidence.alarmId : evidence.eventId;
    const source = sourceId ? byId.get(sourceId) : undefined;
    const media = evidence.media;
    // Check both resources' original scope, independently of the device's current assignment.
    if (
      !source ||
      evidence.customerId !== source.customerId ||
      evidence.deviceId !== source.deviceId ||
      evidence.messageId !== source.sourceMessageId ||
      media.id !== evidence.mediaId ||
      media.customerId !== source.customerId ||
      media.deviceId !== source.deviceId ||
      media.mediaType !== 'IMAGE' ||
      (actor.actorType === 'customer' && media.customerId !== actor.customerId) ||
      (media.status !== 'AVAILABLE' && media.status !== 'DELETED')
    )
      continue;
    result.set(source.id, { mediaId: media.id, captureTime: media.captureTime.toISOString(), status: media.status });
  }
  return result;
}
