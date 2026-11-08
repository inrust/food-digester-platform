-- Offline template. Execute only in a separately authorized isolated target session.
-- psql variables are values, never identifiers. No credentials or target values here.
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT id, device_id, customer_id, kind, message_id, size_bytes, size_kb
FROM media_triggers WHERE device_id = :'device_id' AND customer_id = :'customer_id' AND message_id = :'trigger_message_id';
SELECT e.id, e.trigger_id, e.media_id, e.status, e.alarm_id, e.event_id,
       e.registered_at, e.deadline_at, e.next_attempt_at, e.attempt_count
FROM media_evidence e JOIN media_triggers t ON t.id=e.trigger_id
WHERE t.device_id=:'device_id' AND t.customer_id=:'customer_id' AND t.message_id=:'trigger_message_id';
SELECT s.id, s.status, s.size_bytes, s.created_at, s.presigned_url_expires_at, s.completed_at
FROM media_upload_sessions s JOIN media_triggers t ON t.id=s.trigger_id
WHERE t.device_id=:'device_id' AND t.customer_id=:'customer_id' AND t.message_id=:'trigger_message_id';
SELECT m.id, m.status, m.upload_session_id, m.source_message_id, m.sha256
FROM media_objects m WHERE m.device_id=:'device_id' AND m.customer_id=:'customer_id' AND m.source_message_id=:'media_message_id';
SELECT id, result, payload_hash, seq, processed_at FROM ingestion_receipts WHERE device_id=:'device_id' AND customer_id=:'customer_id' AND topic_type='media' AND seq=:'media_seq'::int;
SELECT source_message_id, status FROM alarms WHERE device_id=:'device_id' AND customer_id=:'customer_id' AND source_message_id=:'trigger_message_id';
SELECT source_message_id FROM device_events WHERE device_id=:'device_id' AND customer_id=:'customer_id' AND source_message_id=:'trigger_message_id';
SELECT device_id, enabled FROM device_live_image_policies WHERE device_id=:'device_id';
SELECT o.id, o.event_type, o.status, o.retry_count, o.aggregate_id
FROM outbox_events o JOIN media_evidence e ON o.aggregate_id=e.id
WHERE o.aggregate_type='media_evidence' AND e.device_id=:'device_id' AND e.customer_id=:'customer_id' AND e.message_id=:'trigger_message_id';
-- PID pairs must come from this run's native concurrency harness; do not export other tenants' activity.
SELECT pid, locktype, mode, granted FROM pg_locks WHERE pid IN (:'reader_pid'::int, :'writer_pid'::int) ORDER BY pid, locktype, mode;
ROLLBACK;
-- Never inspect DDB payload strings here: FRAME payload contains Base64. Collect only
-- CONTROL revision/authEpoch/customerId/streamId/enabled/activeUntilMs/watermarks,
-- and FRAME/DEDUP key + ttl + client-computed digest from an authorized harness.
