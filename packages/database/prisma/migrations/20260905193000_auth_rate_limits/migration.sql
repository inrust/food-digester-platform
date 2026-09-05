-- AUTH-02: shared, atomic fixed-window rate limiting for Onboarding Token and source IP.
CREATE TABLE "auth_rate_limits" (
  "rate_key" TEXT NOT NULL,
  "window_start" TIMESTAMPTZ NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "auth_rate_limits_pkey" PRIMARY KEY ("rate_key", "window_start")
);

CREATE INDEX "auth_rate_limits_expires_at_idx" ON "auth_rate_limits"("expires_at");
