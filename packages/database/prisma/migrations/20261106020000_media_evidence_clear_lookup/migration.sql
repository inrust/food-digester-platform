-- IMG-12: CLEARED has no Alarm row; retain bounded source-disposition lookup in the existing durable Outbox.
BEGIN;
CREATE INDEX "outbox_alarm_cleared_source_idx" ON "outbox_events" (("payload"->>'messageId'))
WHERE "event_type" = 'ARCHIVE' AND "payload"->>'topicType' = 'alarm'
  AND "payload"->'columns'->>'status' = 'CLEARED';
COMMIT;
