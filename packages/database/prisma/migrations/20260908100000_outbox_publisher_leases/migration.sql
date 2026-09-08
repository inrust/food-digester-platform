-- P2: independent Archive/Notification publishers need an atomic, crash-recoverable claim.
ALTER TABLE "outbox_events"
  ADD COLUMN "lease_token" TEXT,
  ADD COLUMN "lease_until" TIMESTAMPTZ,
  ADD COLUMN "last_attempt_at" TIMESTAMPTZ;

CREATE INDEX "outbox_events_status_event_type_lease_until_created_at_idx"
  ON "outbox_events"("status", "event_type", "lease_until", "created_at");
