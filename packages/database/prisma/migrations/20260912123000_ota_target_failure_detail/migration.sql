ALTER TABLE "ota_targets"
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "failure_reason" TEXT;

ALTER TABLE "ota_targets"
  ADD CONSTRAINT "ota_targets_failure_code_length_check"
  CHECK ("failure_code" IS NULL OR char_length("failure_code") BETWEEN 1 AND 64),
  ADD CONSTRAINT "ota_targets_failure_reason_length_check"
  CHECK ("failure_reason" IS NULL OR char_length("failure_reason") BETWEEN 1 AND 500);
