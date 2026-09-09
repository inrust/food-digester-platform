-- P1：Command attempt 真实结果审计；OTA target 条件租约、一次性下载授权与 Outbox 幂等键。
ALTER TABLE "command_attempts"
  ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'PUBLISHED',
  ADD COLUMN "error_code" TEXT,
  ADD COLUMN "provider_message_id" TEXT,
  ADD COLUMN "finished_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "ota_targets"
  ADD COLUMN "dispatch_claimed_at" TIMESTAMPTZ,
  ADD COLUMN "dispatch_lease_until" TIMESTAMPTZ,
  ADD COLUMN "dispatch_lease_token" TEXT,
  ADD COLUMN "dispatch_attempt_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ota_targets_status_dispatch_lease_until_scheduled_time_idx"
  ON "ota_targets"("status", "dispatch_lease_until", "scheduled_time");

CREATE TABLE "ota_download_grants" (
  "id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "device_id" TEXT NOT NULL,
  "package_id" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "used_at" TIMESTAMPTZ,
  "revoked_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ota_download_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ota_download_grants_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "ota_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ota_download_grants_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "firmware_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ota_download_grants_token_hash_key" ON "ota_download_grants"("token_hash");
CREATE INDEX "ota_download_grants_target_id_expires_at_idx" ON "ota_download_grants"("target_id", "expires_at");
CREATE INDEX "ota_download_grants_device_id_expires_at_idx" ON "ota_download_grants"("device_id", "expires_at");

ALTER TABLE "outbox_events" ADD COLUMN "idempotency_key" TEXT;
CREATE UNIQUE INDEX "outbox_events_idempotency_key_key" ON "outbox_events"("idempotency_key");
