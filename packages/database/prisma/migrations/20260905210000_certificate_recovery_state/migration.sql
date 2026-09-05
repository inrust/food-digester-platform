ALTER TABLE "device_certificates"
  ADD COLUMN "recovery_state" TEXT,
  ADD COLUMN "recovery_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "recovery_requested_at" TIMESTAMPTZ,
  ADD COLUMN "recovery_last_attempt_at" TIMESTAMPTZ,
  ADD COLUMN "recovery_last_error" TEXT;

CREATE INDEX "device_certificates_recovery_state_recovery_requested_at_idx"
  ON "device_certificates"("recovery_state", "recovery_requested_at");
