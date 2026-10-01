ALTER TABLE "device_certificates"
  ADD COLUMN "certificate_arn" TEXT,
  ADD COLUMN "certificate_chain" TEXT,
  ADD COLUMN "public_key_fingerprint" TEXT,
  ADD COLUMN "serial_number" TEXT,
  ADD COLUMN "issuer" TEXT,
  ADD COLUMN "mqtt_verified_at" TIMESTAMPTZ,
  ADD COLUMN "rest_verified_at" TIMESTAMPTZ,
  ADD COLUMN "rotation_deadline_at" TIMESTAMPTZ,
  ADD COLUMN "rotation_confirmed_at" TIMESTAMPTZ,
  ADD COLUMN "iot_deactivation_pending" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "iot_deactivation_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "iot_deactivated_at" TIMESTAMPTZ;
CREATE INDEX "device_certificates_public_key_fingerprint_idx" ON "device_certificates"("public_key_fingerprint");
CREATE INDEX "device_certificates_iot_deactivation_pending_revoked_at_idx" ON "device_certificates"("iot_deactivation_pending", "revoked_at");
CREATE INDEX "device_certificates_rotation_confirmed_at_rotation_deadline_idx" ON "device_certificates"("rotation_confirmed_at", "rotation_deadline_at");
-- Legacy delivered rotation windows get a bounded grace period; no fabricated channel verification.
UPDATE "device_certificates" SET "rotation_deadline_at" = CURRENT_TIMESTAMP + INTERVAL '24 hours'
WHERE "rotated_from_id" IS NOT NULL AND "status" = 'ACTIVE';

UPDATE "device_certificates" AS new_cert SET "rotation_confirmed_at" = CURRENT_TIMESTAMP
FROM "device_certificates" AS old_cert
WHERE new_cert."rotated_from_id" = old_cert.id AND old_cert.status = 'REVOKED' AND new_cert.status = 'ACTIVE';
CREATE TABLE "device_public_keys" (
  "fingerprint" TEXT PRIMARY KEY,
  "device_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_public_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "device_public_keys_device_id_idx" ON "device_public_keys"("device_id");
-- Conflicting historical key ownership must be resolved before deploying this migration.
INSERT INTO "device_public_keys" ("fingerprint", "device_id")
SELECT DISTINCT request.public_key_fingerprint, device.id FROM onboarding_requests AS request
JOIN devices AS device ON device.serial_number = request.serial_number;
