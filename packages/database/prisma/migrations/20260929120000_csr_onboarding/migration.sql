ALTER TABLE "onboarding_requests"
  ALTER COLUMN "token_id" DROP NOT NULL,
  ADD COLUMN "csr_pem" TEXT,
  ADD COLUMN "public_key_fingerprint" TEXT;

ALTER TABLE "onboarding_requests" DROP CONSTRAINT "onboarding_requests_token_id_fkey";
ALTER TABLE "onboarding_requests" ADD CONSTRAINT "onboarding_requests_token_id_fkey"
  FOREIGN KEY ("token_id") REFERENCES "onboarding_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "onboarding_proof_nonces" (
  "request_id" TEXT NOT NULL,
  "nonce_hash" TEXT NOT NULL,
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "onboarding_proof_nonces_pkey" PRIMARY KEY ("request_id", "nonce_hash"),
  CONSTRAINT "onboarding_proof_nonces_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "onboarding_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "onboarding_proof_nonces_expires_at_idx" ON "onboarding_proof_nonces"("expires_at");
