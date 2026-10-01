/** Record the authenticated MQTT channel; retire old identity only when REST Sync has also succeeded. */
import type { DbClient } from '@fdp/database';
import { recordCertificateVerification } from '@fdp/auth';
import type { SecurePackageService } from '@fdp/auth';
export interface RotationConfirmationInput {
  readonly deviceId: string;
  readonly certificateFingerprint: string;
}
export interface RotationConfirmationDeps {
  readonly client: DbClient;
  readonly securePackage: SecurePackageService;
  readonly now?: () => Date;
}
export interface RotationConfirmationResult {
  readonly deviceId: string;
  readonly confirmed: boolean;
  readonly revokedCertificateId: string | null;
}
export async function confirmCertificateRotationOnFirstHeartbeat(
  deps: RotationConfirmationDeps,
  input: RotationConfirmationInput,
) {
  const result = await recordCertificateVerification(
    deps.client,
    { ...input, channel: 'mqtt' },
    deps.now?.() ?? new Date(),
  );
  return { deviceId: input.deviceId, ...result };
}
