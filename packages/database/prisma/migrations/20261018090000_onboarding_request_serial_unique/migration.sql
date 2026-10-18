-- Preserve historical requests. If a serial has multiple historical attempts,
-- stop for operator review rather than deleting or rewriting those records.
BEGIN;
CREATE UNIQUE INDEX "onboarding_requests_serial_number_key"
  ON "onboarding_requests"("serial_number");
DROP INDEX "onboarding_requests_one_pending_per_serial";
COMMIT;
