-- DEC-017@1.0.0：证书包存储完成后 24 小时首个 Heartbeat 硬截止。
-- TIMED_OUT 仅为内部 Onboarding 请求状态，外部仍映射为 REJECTED/ONBOARDING_TIMEOUT。
ALTER TABLE "onboarding_requests"
  ADD COLUMN "onboarding_deadline_at" TIMESTAMPTZ,
  ADD COLUMN "timed_out_at" TIMESTAMPTZ,
  ADD COLUMN "revocation_completed_at" TIMESTAMPTZ;

CREATE INDEX "onboarding_requests_deadline_idx"
  ON "onboarding_requests" ("status", "onboarding_deadline_at")
  WHERE "status" = 'APPROVED' AND "timed_out_at" IS NULL;
