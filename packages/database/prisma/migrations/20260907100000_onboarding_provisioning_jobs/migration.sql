-- P1: APPROVED -> provisioning 改为持久化任务驱动，支持认领、退避重试、失败告警与 AWS 对账。
CREATE TABLE "onboarding_provisioning_jobs" (
    "id" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "operation_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 8,
    "issued_certificate_id" TEXT,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_attempt_at" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "onboarding_provisioning_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "onboarding_provisioning_jobs_status_check"
      CHECK ("status" IN ('PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'FAILED')),
    CONSTRAINT "onboarding_provisioning_jobs_attempts_check"
      CHECK ("attempts" >= 0 AND "max_attempts" > 0 AND "attempts" <= "max_attempts")
);

CREATE UNIQUE INDEX "onboarding_provisioning_jobs_request_id_key"
  ON "onboarding_provisioning_jobs"("request_id");
CREATE UNIQUE INDEX "onboarding_provisioning_jobs_operation_id_key"
  ON "onboarding_provisioning_jobs"("operation_id");
CREATE INDEX "onboarding_provisioning_jobs_status_next_attempt_at_idx"
  ON "onboarding_provisioning_jobs"("status", "next_attempt_at");

ALTER TABLE "onboarding_provisioning_jobs"
  ADD CONSTRAINT "onboarding_provisioning_jobs_request_id_fkey"
  FOREIGN KEY ("request_id") REFERENCES "onboarding_requests"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 为升级前已 APPROVED 但尚未形成可领取包的申请补建可重试任务。
INSERT INTO "onboarding_provisioning_jobs" (
  "id", "request_id", "operation_id", "status", "next_attempt_at", "created_at", "updated_at"
)
SELECT
  'onb-prov-job-' || r."id",
  r."id",
  'onb-prov-op-' || r."id",
  'PENDING',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "onboarding_requests" r
WHERE r."status" = 'APPROVED'
  AND r."onboarding_deadline_at" IS NULL
ON CONFLICT ("request_id") DO NOTHING;
