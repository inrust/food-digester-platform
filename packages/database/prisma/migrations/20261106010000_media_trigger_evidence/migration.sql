-- IMG-09 additive schema. No source inference or guessed size backfill.
BEGIN;

-- AlterTable
ALTER TABLE "media_upload_sessions" ADD COLUMN     "size_bytes" INTEGER,
ADD COLUMN     "trigger_id" TEXT;

-- CreateTable
CREATE TABLE "media_triggers" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message_id" TEXT COLLATE "C" NOT NULL,
    "media_type" TEXT NOT NULL DEFAULT 'IMAGE',
    "file_name" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "size_kb" INTEGER NOT NULL,
    "sha256_normalized" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_evidence" (
    "id" TEXT NOT NULL,
    "trigger_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "message_id" TEXT COLLATE "C" NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "alarm_id" TEXT,
    "event_id" TEXT,
    "registered_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deadline_at" TIMESTAMPTZ NOT NULL,
    "next_attempt_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "failure_reason" TEXT,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_triggers_ref_key" ON "media_triggers"("customer_id", "device_id", "kind", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_triggers_evidence_scope_key" ON "media_triggers"("id", "customer_id", "device_id", "kind", "message_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_evidence_trigger_id_key" ON "media_evidence"("trigger_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_evidence_media_id_key" ON "media_evidence"("media_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_evidence_alarm_id_key" ON "media_evidence"("alarm_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_evidence_event_id_key" ON "media_evidence"("event_id");

-- CreateIndex
CREATE INDEX "media_evidence_pending_scan_idx" ON "media_evidence"("status", "next_attempt_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "alarms_evidence_scope_key" ON "alarms"("id", "customer_id", "device_id", "source_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_events_evidence_scope_key" ON "device_events"("id", "customer_id", "device_id", "source_message_id");

-- CreateIndex
CREATE INDEX "media_upload_sessions_trigger_lookup_idx" ON "media_upload_sessions"("trigger_id", "status", "presigned_url_expires_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "media_objects_evidence_scope_key" ON "media_objects"("id", "customer_id", "device_id");

-- AddForeignKey
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "media_triggers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "media_triggers" ADD CONSTRAINT "media_triggers_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "media_triggers" ADD CONSTRAINT "media_triggers_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_trigger_id_fkey" FOREIGN KEY ("trigger_id") REFERENCES "media_triggers"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media_objects"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_alarm_id_fkey" FOREIGN KEY ("alarm_id") REFERENCES "alarms"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "device_events"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- Rounded historical size_kb cannot determine exact byte length. Leave new columns NULL.
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_sessions_exact_size_check"
  CHECK ("size_bytes" IS NULL OR ("size_bytes" > 0 AND "size_kb" = (("size_bytes"::bigint + 1023) / 1024)));
ALTER TABLE "media_triggers" ADD CONSTRAINT "media_triggers_declaration_check" CHECK (
  "kind" IN ('EVENT', 'ALARM') AND "media_type" = 'IMAGE'
  AND "message_id" ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,127}$'
  AND "file_name" ~ '^[A-Za-z0-9._-]{1,128}$'
  AND "size_bytes" BETWEEN 1 AND 10485760
  AND "size_kb" = (("size_bytes"::bigint + 1023) / 1024)
  AND "sha256_normalized" ~ '^[0-9a-f]{64}$'
);
-- Expired ISSUED attempts must explicitly transition to EXPIRED under the device/trigger lock
-- before a replacement is created. Legacy sessions (trigger_id NULL) are unrestricted.
CREATE UNIQUE INDEX "media_sessions_one_issued_trigger_key" ON "media_upload_sessions" ("trigger_id")
  WHERE "trigger_id" IS NOT NULL AND "status" = 'ISSUED';

-- Prisma models the simple relations. Additional composite FKs keep all identity snapshots
-- consistent in both directions, including later parent updates and concurrent writers.
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_trigger_scope_fkey"
  FOREIGN KEY ("trigger_id", "customer_id", "device_id", "kind", "message_id")
  REFERENCES "media_triggers" ("id", "customer_id", "device_id", "kind", "message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_media_scope_fkey"
  FOREIGN KEY ("media_id", "customer_id", "device_id")
  REFERENCES "media_objects" ("id", "customer_id", "device_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_alarm_scope_fkey"
  FOREIGN KEY ("alarm_id", "customer_id", "device_id", "message_id")
  REFERENCES "alarms" ("id", "customer_id", "device_id", "source_message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_event_scope_fkey"
  FOREIGN KEY ("event_id", "customer_id", "device_id", "message_id")
  REFERENCES "device_events" ("id", "customer_id", "device_id", "source_message_id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_state_check" CHECK (
  ("status" = 'PENDING' AND "alarm_id" IS NULL AND "event_id" IS NULL AND "next_attempt_at" IS NOT NULL)
  OR ("status" = 'UNMATCHED' AND "alarm_id" IS NULL AND "event_id" IS NULL AND "next_attempt_at" IS NULL AND "failure_reason" IS NOT NULL)
  OR ("status" = 'LINKED' AND "next_attempt_at" IS NULL AND "failure_reason" IS NULL AND (
    ("kind" = 'ALARM' AND "alarm_id" IS NOT NULL AND "event_id" IS NULL)
    OR ("kind" = 'EVENT' AND "event_id" IS NOT NULL AND "alarm_id" IS NULL)
  ))
);
ALTER TABLE "media_evidence" ADD CONSTRAINT "media_evidence_schedule_check" CHECK (
  "deadline_at" = "registered_at" + INTERVAL '24 hours'
  AND ("next_attempt_at" IS NULL OR "next_attempt_at" BETWEEN "registered_at" AND "deadline_at")
  AND "attempt_count" >= 0 AND "updated_at" >= "registered_at"
  AND ("failure_reason" IS NULL OR "failure_reason" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);

CREATE FUNCTION "fdp_media_trigger_immutable"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'media trigger declarations cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'media trigger declarations are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "media_triggers_immutable" BEFORE UPDATE OR DELETE ON "media_triggers"
  FOR EACH ROW EXECUTE FUNCTION "fdp_media_trigger_immutable"();
CREATE FUNCTION "fdp_media_trigger_current_owner"() RETURNS trigger AS $$
DECLARE actual_customer TEXT;
BEGIN
  SELECT "customer_id" INTO actual_customer FROM "devices" WHERE "id" = NEW."device_id" FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing trigger device' USING ERRCODE = '23503'; END IF;
  IF actual_customer IS DISTINCT FROM NEW."customer_id" THEN
    RAISE EXCEPTION 'trigger device/customer mismatch' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "media_triggers_current_owner" BEFORE INSERT ON "media_triggers"
  FOR EACH ROW EXECUTE FUNCTION "fdp_media_trigger_current_owner"();

CREATE FUNCTION "fdp_media_session_declaration"() RETURNS trigger AS $$
DECLARE
  declaration "media_triggers"%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."trigger_id" IS NOT NULL THEN
      RAISE EXCEPTION 'bound session attempts must be retained' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."trigger_id" IS DISTINCT FROM OLD."trigger_id" THEN
      RAISE EXCEPTION 'session trigger binding cannot be changed' USING ERRCODE = '23514';
    END IF;
    IF OLD."trigger_id" IS NOT NULL AND (
      ROW(NEW."id", NEW."device_id", NEW."customer_id", NEW."media_type", NEW."file_name", NEW."size_bytes", NEW."size_kb", NEW."declared_sha256", NEW."created_at", NEW."presigned_url_expires_at")
      IS DISTINCT FROM ROW(OLD."id", OLD."device_id", OLD."customer_id", OLD."media_type", OLD."file_name", OLD."size_bytes", OLD."size_kb", OLD."declared_sha256", OLD."created_at", OLD."presigned_url_expires_at")
      OR (OLD."status" <> 'ISSUED' AND NEW IS DISTINCT FROM OLD)
    ) THEN
      RAISE EXCEPTION 'bound session declaration and terminal state are immutable' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NEW."trigger_id" IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO declaration FROM "media_triggers" WHERE "id" = NEW."trigger_id" FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'missing media trigger' USING ERRCODE = '23503'; END IF;
  IF NEW."size_bytes" IS NULL OR NEW."declared_sha256" IS NULL OR NEW."status" NOT IN ('ISSUED', 'COMPLETED', 'EXPIRED')
    OR ROW(NEW."device_id", NEW."customer_id", NEW."media_type", NEW."file_name", NEW."size_bytes", NEW."size_kb", NEW."declared_sha256")
    IS DISTINCT FROM ROW(declaration."device_id", declaration."customer_id", declaration."media_type", declaration."file_name", declaration."size_bytes", declaration."size_kb", declaration."sha256_normalized") THEN
    RAISE EXCEPTION 'session declaration differs from trigger' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "media_sessions_trigger_declaration" BEFORE INSERT OR UPDATE OR DELETE ON "media_upload_sessions"
  FOR EACH ROW EXECUTE FUNCTION "fdp_media_session_declaration"();

CREATE FUNCTION "fdp_bound_media_declaration"() RETURNS trigger AS $$
DECLARE
  bound_before BOOLEAN := false;
  bound_after BOOLEAN := false;
  declaration "media_triggers"%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    SELECT EXISTS(SELECT 1 FROM "media_upload_sessions" WHERE "id" = OLD."upload_session_id" AND "trigger_id" IS NOT NULL) INTO bound_before;
  END IF;
  SELECT t.* INTO declaration FROM "media_upload_sessions" s JOIN "media_triggers" t ON t."id" = s."trigger_id"
    WHERE s."id" = NEW."upload_session_id";
  bound_after := FOUND;
  IF TG_OP = 'UPDATE' AND (bound_before OR bound_after) AND
    ROW(NEW."id", NEW."device_id", NEW."customer_id", NEW."upload_session_id", NEW."media_type", NEW."capture_time", NEW."file_name", NEW."object_path", NEW."size_kb", NEW."duration_sec", NEW."sha256", NEW."source_message_id", NEW."created_at")
    IS DISTINCT FROM ROW(OLD."id", OLD."device_id", OLD."customer_id", OLD."upload_session_id", OLD."media_type", OLD."capture_time", OLD."file_name", OLD."object_path", OLD."size_kb", OLD."duration_sec", OLD."sha256", OLD."source_message_id", OLD."created_at") THEN
    RAISE EXCEPTION 'bound media declaration is immutable' USING ERRCODE = '23514';
  END IF;
  IF bound_after AND (NEW."status" NOT IN ('AVAILABLE', 'DELETED') OR NEW."sha256" IS NULL OR (NEW."duration_sec" IS NOT NULL AND NEW."duration_sec" <> 0) OR
    ROW(NEW."device_id", NEW."customer_id", NEW."media_type", NEW."file_name", NEW."size_kb", NEW."sha256") IS DISTINCT FROM
    ROW(declaration."device_id", declaration."customer_id", declaration."media_type", declaration."file_name", declaration."size_kb", declaration."sha256_normalized")) THEN
    RAISE EXCEPTION 'media declaration differs from trigger' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "media_objects_trigger_declaration" BEFORE INSERT OR UPDATE ON "media_objects"
  FOR EACH ROW EXECUTE FUNCTION "fdp_bound_media_declaration"();

CREATE FUNCTION "fdp_media_evidence_integrity"() RETURNS trigger AS $$
DECLARE
  registered_trigger TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'evidence records must be retained' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' AND NEW."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'evidence must start PENDING' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (
    ROW(NEW."id", NEW."trigger_id", NEW."media_id", NEW."customer_id", NEW."device_id", NEW."kind", NEW."message_id", NEW."registered_at", NEW."deadline_at") IS DISTINCT FROM
    ROW(OLD."id", OLD."trigger_id", OLD."media_id", OLD."customer_id", OLD."device_id", OLD."kind", OLD."message_id", OLD."registered_at", OLD."deadline_at")
    OR (OLD."status" <> 'PENDING' AND NEW IS DISTINCT FROM OLD)
    OR NEW."attempt_count" < OLD."attempt_count"
  ) THEN
    RAISE EXCEPTION 'evidence identity, deadline and terminal state are immutable' USING ERRCODE = '23514';
  END IF;
  SELECT s."trigger_id" INTO registered_trigger FROM "media_objects" m
    JOIN "media_upload_sessions" s ON s."id" = m."upload_session_id"
    WHERE m."id" = NEW."media_id" AND s."status" = 'COMPLETED';
  IF registered_trigger IS DISTINCT FROM NEW."trigger_id" THEN
    RAISE EXCEPTION 'media belongs to a different trigger or legacy session' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "media_evidence_integrity" BEFORE INSERT OR UPDATE OR DELETE ON "media_evidence"
  FOR EACH ROW EXECUTE FUNCTION "fdp_media_evidence_integrity"();

COMMIT;
