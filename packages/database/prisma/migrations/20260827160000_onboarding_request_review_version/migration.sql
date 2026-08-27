-- BE-ONB-02：onboarding_requests 增加乐观锁版本列（If-Match 防重复审批）
ALTER TABLE "onboarding_requests" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
