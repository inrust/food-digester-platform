-- BE-OTA-02 P2：持久化最终全量扩批审批事实，避免灰度成功后过早完成 Campaign。
ALTER TABLE "ota_campaigns"
  ADD COLUMN "final_rollout_approved_at" TIMESTAMPTZ(6),
  ADD COLUMN "final_rollout_approved_by" TEXT,
  ADD COLUMN "final_rollout_eligible_count" INTEGER;

ALTER TABLE "ota_campaigns"
  ADD CONSTRAINT "ota_campaigns_final_rollout_approval_check"
  CHECK (
    ("final_rollout_approved_at" IS NULL AND "final_rollout_approved_by" IS NULL AND "final_rollout_eligible_count" IS NULL)
    OR
    ("final_rollout_approved_at" IS NOT NULL AND "final_rollout_approved_by" IS NOT NULL AND "final_rollout_eligible_count" > 0)
  );
