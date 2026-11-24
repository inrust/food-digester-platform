ALTER TABLE "consumable_requests" ADD COLUMN IF NOT EXISTS "stage_notes" JSONB;

-- The old create audit identifies a device, not a request. Both timestamps have
-- the same database transaction default. Only an exact, one-to-one match counts.
WITH candidate_notes AS (
  SELECT r.id AS request_id, a.id AS audit_id, 'request' AS stage, a.reason
    FROM consumable_requests AS r
    JOIN audit_logs AS a
      ON a.object_type = 'consumableRequest'
     AND a.result = 'SUCCESS'
     AND a.action = 'consumable.request.create'
     AND a.object_id = r.device_id
     AND a.customer_id = r.customer_id
     AND a.actor_id = r.requested_by
     AND a.created_at = r.requested_at
     AND a.after_value->>'deviceId' = r.device_id
     AND a.after_value->>'consumableType' = r.consumable_type
     AND a.after_value->>'status' = 'PENDING'
     AND (NOT (a.after_value ? 'requestId') OR a.after_value->>'requestId' = r.id)
   WHERE r.source = 'ADMIN' AND r.requested_at = r.created_at
  UNION ALL
  SELECT r.id, a.id,
         CASE a.action
           WHEN 'consumable.request.process' THEN 'processing'
           WHEN 'consumable.request.complete' THEN 'completion'
           WHEN 'consumable.request.cancel' THEN 'cancellation'
         END,
         a.reason
    FROM consumable_requests AS r
    JOIN audit_logs AS a
      ON a.object_type = 'consumableRequest'
     AND a.result = 'SUCCESS'
     AND a.object_id = r.id
     AND (a.customer_id IS NULL OR a.customer_id = r.customer_id)
     AND a.actor_id = a.after_value->>'processedBy'
     AND a.created_at >= r.requested_at
   WHERE (
      a.action = 'consumable.request.process'
      AND a.before_value->>'version' = '1'
      AND a.after_value->>'version' = '2'
      AND a.after_value->>'status' = 'PROCESSING'
      AND (
        (r.status = 'PROCESSING' AND r.version = 2 AND r.processed_by = a.actor_id)
        OR (r.status IN ('COMPLETED', 'CANCELLED') AND r.version = 3)
      )
   ) OR (
      a.action = 'consumable.request.complete'
      AND a.before_value->>'version' = '2'
      AND a.after_value->>'version' = '3'
      AND a.after_value->>'status' = 'COMPLETED'
      AND r.status = 'COMPLETED' AND r.version = 3 AND r.processed_by = a.actor_id
   ) OR (
      a.action = 'consumable.request.cancel'
      AND a.after_value->>'status' = 'CANCELLED'
      AND r.status = 'CANCELLED' AND r.version IN (2, 3) AND r.processed_by = a.actor_id
      AND a.before_value->>'version' = (r.version - 1)::text
      AND a.after_value->>'version' = r.version::text
   )
), counted AS (
  SELECT *,
         count(*) OVER (PARTITION BY request_id, stage) AS matches_for_stage,
         count(*) OVER (PARTITION BY audit_id) AS matches_for_audit
    FROM candidate_notes
), recovered AS (
  SELECT request_id,
         jsonb_object_agg(stage, jsonb_build_object('note', reason, 'source', 'AUDIT', 'auditId', audit_id)) AS notes
    FROM counted
   WHERE matches_for_stage = 1 AND matches_for_audit = 1
     AND reason ~ '[^[:space:]]' AND char_length(reason) <= 500
     AND reason <> '[REDACTED]'
   GROUP BY request_id
), existing_and_recovered AS (
  SELECT r.id, r.process_note,
         COALESCE(recovered.notes, '{}'::jsonb) || COALESCE(r.stage_notes, '{}'::jsonb) AS notes
    FROM consumable_requests AS r
    LEFT JOIN recovered ON recovered.request_id = r.id
), classified AS (
  SELECT id,
         CASE WHEN process_note IS NULL OR COALESCE(notes->'legacy', '[]'::jsonb) ? process_note
                OR EXISTS (SELECT 1 FROM jsonb_each(notes - 'legacy') AS phase WHERE phase.value->>'note' = process_note)
              THEN notes
              ELSE jsonb_set(notes, '{legacy}', COALESCE(notes->'legacy', '[]'::jsonb) || jsonb_build_array(process_note))
         END AS notes
    FROM existing_and_recovered
)
UPDATE consumable_requests AS r
   SET stage_notes = classified.notes
  FROM classified
 WHERE classified.id = r.id
   AND classified.notes <> '{}'::jsonb
   AND r.stage_notes IS DISTINCT FROM classified.notes;
