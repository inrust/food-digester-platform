-- P1: event-time attribution, historical Customer/Site dimensions, completeness evidence,
-- and recoverable Replay leases.

ALTER TABLE "ingestion_receipts"
  ADD COLUMN "customer_id" TEXT,
  ADD COLUMN "site_id" TEXT,
  ADD COLUMN "occurred_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

UPDATE "ingestion_receipts" r
SET "occurred_at" = r."received_at",
    "customer_id" = d."customer_id",
    "site_id" = d."site_id"
FROM "devices" d
WHERE d."id" = r."device_id";

ALTER TABLE "ingestion_receipts" ALTER COLUMN "occurred_at" SET NOT NULL;

ALTER TABLE "telemetry_hourly"
  ADD COLUMN "site_id" TEXT NOT NULL DEFAULT '__UNASSIGNED__',
  ADD COLUMN "missing_record_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "telemetry_daily"
  ADD COLUMN "site_id" TEXT NOT NULL DEFAULT '__UNASSIGNED__',
  ADD COLUMN "missing_record_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "esg_reports"
  ADD COLUMN "site_id" TEXT NOT NULL DEFAULT '__UNASSIGNED__';
ALTER TABLE "esg_daily_summary"
  ADD COLUMN "site_id" TEXT NOT NULL DEFAULT '__UNASSIGNED__';

UPDATE "telemetry_hourly" t SET "site_id" = COALESCE(d."site_id", '__UNASSIGNED__')
FROM "devices" d WHERE d."id" = t."device_id";
UPDATE "telemetry_daily" t SET "site_id" = COALESCE(d."site_id", '__UNASSIGNED__')
FROM "devices" d WHERE d."id" = t."device_id";
UPDATE "esg_reports" t SET "site_id" = COALESCE(d."site_id", '__UNASSIGNED__')
FROM "devices" d WHERE d."id" = t."device_id";
UPDATE "esg_daily_summary" t SET "site_id" = COALESCE(d."site_id", '__UNASSIGNED__')
FROM "devices" d WHERE d."id" = t."device_id";

DROP INDEX "telemetry_hourly_device_id_bucket_start_key";
DROP INDEX "telemetry_daily_device_id_bucket_date_key";
DROP INDEX "esg_reports_device_id_report_type_period_start_time_key";
DROP INDEX "esg_daily_summary_device_id_summary_date_key";

CREATE UNIQUE INDEX "telemetry_hourly_device_id_customer_id_site_id_bucket_start_key"
  ON "telemetry_hourly"("device_id", "customer_id", "site_id", "bucket_start");
CREATE UNIQUE INDEX "telemetry_daily_device_id_customer_id_site_id_bucket_date_key"
  ON "telemetry_daily"("device_id", "customer_id", "site_id", "bucket_date");
CREATE UNIQUE INDEX "esg_reports_device_id_customer_id_site_id_report_type_perio_key"
  ON "esg_reports"("device_id", "customer_id", "site_id", "report_type", "period_start_time");
CREATE UNIQUE INDEX "esg_daily_summary_device_id_customer_id_site_id_summary_dat_key"
  ON "esg_daily_summary"("device_id", "customer_id", "site_id", "summary_date");

-- These are immutable historical facts. They must remain valid after a device is reassigned.
DROP TRIGGER IF EXISTS "telemetry_hourly_device_customer_consistency" ON "telemetry_hourly";
DROP TRIGGER IF EXISTS "telemetry_daily_device_customer_consistency" ON "telemetry_daily";
DROP TRIGGER IF EXISTS "esg_reports_device_customer_consistency" ON "esg_reports";
DROP TRIGGER IF EXISTS "esg_daily_summary_device_customer_consistency" ON "esg_daily_summary";

ALTER TABLE "replay_jobs"
  ADD COLUMN "started_at" TIMESTAMPTZ,
  ADD COLUMN "lease_until" TIMESTAMPTZ,
  ADD COLUMN "last_heartbeat_at" TIMESTAMPTZ,
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "replay_jobs_status_lease_until_idx" ON "replay_jobs"("status", "lease_until");
