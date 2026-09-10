ALTER TABLE "onboarding_requests"
ADD COLUMN "submitted_by" TEXT NOT NULL DEFAULT 'DEVICE';

UPDATE "onboarding_requests"
SET "submitted_by" = 'DEVICE:' || "serial_number";

ALTER TABLE "onboarding_requests"
ALTER COLUMN "submitted_by" DROP DEFAULT;
