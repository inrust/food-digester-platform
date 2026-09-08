-- DEC-019@1.0.0：alias 先 trim + NFC，区分大小写；同 Customer（含 null 未分配域）唯一。
UPDATE "devices"
SET "alias" = normalize(btrim("alias"), NFC)
WHERE "alias" IS NOT NULL;

ALTER TABLE "devices"
ADD CONSTRAINT "devices_alias_frozen_check"
CHECK (
  "alias" IS NULL OR (
    "alias" = btrim("alias")
    AND "alias" = normalize("alias", NFC)
    AND char_length("alias") BETWEEN 1 AND 64
  )
);

CREATE UNIQUE INDEX "devices_customer_alias_unique_idx"
ON "devices" ((COALESCE("customer_id", '')), "alias")
WHERE "alias" IS NOT NULL;

-- DEC-014：退役 DB 完成与 AWS IoT 证书 INACTIVE 分阶段持久化，支持失败重试与租约回收。
ALTER TABLE "device_retirements"
ADD COLUMN "iot_revocation_status" TEXT,
ADD COLUMN "iot_revocation_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "iot_revocation_requested_at" TIMESTAMPTZ,
ADD COLUMN "iot_revocation_last_attempt_at" TIMESTAMPTZ,
ADD COLUMN "iot_revocation_completed_at" TIMESTAMPTZ,
ADD COLUMN "iot_revocation_last_error" TEXT,
ADD COLUMN "iot_revocation_lease_until" TIMESTAMPTZ,
ADD COLUMN "iot_revocation_lease_token" TEXT;

UPDATE "device_retirements"
SET "iot_revocation_status" = 'PENDING',
    "iot_revocation_requested_at" = COALESCE("confirmed_at", "certificate_revoked_at", "created_at")
WHERE "status" = 'CONFIRMED';

CREATE INDEX "device_retirements_iot_revocation_status_iot_revocation_lea_idx"
ON "device_retirements" ("iot_revocation_status", "iot_revocation_lease_until");
