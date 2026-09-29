-- Old token-only requests cannot be silently converted to CSR identity. Migration fails
-- until any development rows without CSR are explicitly removed or reconciled.
ALTER TABLE "onboarding_requests"
  ALTER COLUMN "csr_pem" SET NOT NULL,
  ALTER COLUMN "public_key_fingerprint" SET NOT NULL;

ALTER TABLE "onboarding_requests"
  DROP CONSTRAINT "onboarding_requests_token_id_fkey",
  DROP COLUMN "token_id";

DROP TABLE "onboarding_tokens";
