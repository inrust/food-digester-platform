-- P0 审计整改：补齐 Customer/Device/Site/Contract 归属约束，并统一有效 License 集合。

-- 历史手写 Migration 曾把这些列建成 TIMESTAMPTZ(3)，而 Prisma Schema 的
-- @db.Timestamptz 契约为 PostgreSQL 默认精度（6）；使用向前 Migration 消除漂移。
ALTER TABLE "certificate_rotation_requests"
  ALTER COLUMN "notified_at" TYPE TIMESTAMPTZ,
  ALTER COLUMN "completed_at" TYPE TIMESTAMPTZ,
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ;
ALTER TABLE "device_retirements"
  ALTER COLUMN "initiated_at" TYPE TIMESTAMPTZ,
  ALTER COLUMN "confirmed_at" TYPE TIMESTAMPTZ,
  ALTER COLUMN "certificate_revoked_at" TYPE TIMESTAMPTZ,
  ALTER COLUMN "created_at" TYPE TIMESTAMPTZ;

-- 一个设备仅一个有效 License：领域层把 Renewed 视为有效，数据库必须并发兜底。
DROP INDEX "licenses_one_valid_per_device";
CREATE UNIQUE INDEX "licenses_one_valid_per_device"
  ON "licenses" ("device_id")
  WHERE "status" IN ('Issued', 'Active', 'ExpiringSoon', 'Renewed');

-- Customer 范围表禁止孤儿 customer_id。
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_devices" ADD CONSTRAINT "contract_devices_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_users" ADD CONSTRAINT "device_users_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_user_assignments" ADD CONSTRAINT "device_user_assignments_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_latest_state" ADD CONSTRAINT "device_latest_state_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telemetry_hourly" ADD CONSTRAINT "telemetry_hourly_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telemetry_daily" ADD CONSTRAINT "telemetry_daily_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consumable_projections" ADD CONSTRAINT "consumable_projections_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consumable_requests" ADD CONSTRAINT "consumable_requests_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "esg_reports" ADD CONSTRAINT "esg_reports_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "esg_daily_summary" ADD CONSTRAINT "esg_daily_summary_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tamper_events" ADD CONSTRAINT "tamper_events_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "esg_export_jobs" ADD CONSTRAINT "esg_export_jobs_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "customer_notification_configs" ADD CONSTRAINT "customer_notification_configs_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_customer_id_fkey"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 补齐业务表到 Device/Site 的基础外键。
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contract_devices" ADD CONSTRAINT "contract_devices_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_user_assignments" ADD CONSTRAINT "device_user_assignments_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telemetry_hourly" ADD CONSTRAINT "telemetry_hourly_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "telemetry_daily" ADD CONSTRAINT "telemetry_daily_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consumable_projections" ADD CONSTRAINT "consumable_projections_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "consumable_requests" ADD CONSTRAINT "consumable_requests_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "esg_reports" ADD CONSTRAINT "esg_reports_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "esg_daily_summary" ADD CONSTRAINT "esg_daily_summary_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "alarms" ADD CONSTRAINT "alarms_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tamper_events" ADD CONSTRAINT "tamper_events_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_upload_sessions" ADD CONSTRAINT "media_upload_sessions_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 所有新增/修改的 device+customer 行必须匹配设备当前 Customer。
CREATE FUNCTION "fdp_assert_device_customer"() RETURNS trigger AS $$
DECLARE
  actual_customer TEXT;
BEGIN
  SELECT "customer_id" INTO actual_customer FROM "devices" WHERE "id" = NEW."device_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'device_id % does not exist', NEW."device_id" USING ERRCODE = '23503';
  END IF;
  IF NEW."customer_id" IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM "customers" WHERE "id" = NEW."customer_id") THEN
    RAISE EXCEPTION 'customer_id % does not exist', NEW."customer_id" USING ERRCODE = '23503';
  END IF;
  IF actual_customer IS DISTINCT FROM NEW."customer_id" THEN
    RAISE EXCEPTION 'device/customer mismatch for device %', NEW."device_id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "fdp_assert_site_customer"() RETURNS trigger AS $$
DECLARE
  actual_customer TEXT;
BEGIN
  IF NEW."site_id" IS NULL THEN RETURN NEW; END IF;
  SELECT "customer_id" INTO actual_customer FROM "sites" WHERE "id" = NEW."site_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'site_id % does not exist', NEW."site_id" USING ERRCODE = '23503';
  END IF;
  IF actual_customer IS DISTINCT FROM NEW."customer_id" THEN
    RAISE EXCEPTION 'site/customer mismatch for site %', NEW."site_id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "fdp_assert_contract_customer"() RETURNS trigger AS $$
DECLARE
  actual_customer TEXT;
BEGIN
  SELECT "customer_id" INTO actual_customer FROM "contracts" WHERE "id" = NEW."contract_id";
  IF actual_customer IS DISTINCT FROM NEW."customer_id" THEN
    RAISE EXCEPTION 'contract/customer mismatch for contract %', NEW."contract_id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE FUNCTION "fdp_assert_device_user_customer"() RETURNS trigger AS $$
DECLARE
  actual_customer TEXT;
BEGIN
  SELECT "customer_id" INTO actual_customer FROM "device_users" WHERE "id" = NEW."device_user_id";
  IF actual_customer IS DISTINCT FROM NEW."customer_id" THEN
    RAISE EXCEPTION 'device-user/customer mismatch for user %', NEW."device_user_id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "devices_site_customer_consistency"
  BEFORE INSERT OR UPDATE OF "site_id", "customer_id" ON "devices"
  FOR EACH ROW EXECUTE FUNCTION "fdp_assert_site_customer"();
CREATE TRIGGER "device_assignments_site_customer_consistency"
  BEFORE INSERT OR UPDATE OF "site_id", "customer_id" ON "device_assignments"
  FOR EACH ROW EXECUTE FUNCTION "fdp_assert_site_customer"();
CREATE TRIGGER "contract_devices_contract_customer_consistency"
  BEFORE INSERT OR UPDATE OF "contract_id", "customer_id" ON "contract_devices"
  FOR EACH ROW EXECUTE FUNCTION "fdp_assert_contract_customer"();
CREATE TRIGGER "device_user_assignments_user_customer_consistency"
  BEFORE INSERT OR UPDATE OF "device_user_id", "customer_id" ON "device_user_assignments"
  FOR EACH ROW EXECUTE FUNCTION "fdp_assert_device_user_customer"();

DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'device_assignments', 'contract_devices', 'licenses', 'device_user_assignments',
    'device_latest_state', 'telemetry_hourly', 'telemetry_daily', 'consumable_projections',
    'consumable_requests', 'esg_reports', 'esg_daily_summary', 'alarms', 'device_events',
    'tamper_events', 'device_commands', 'media_upload_sessions', 'media_objects'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF device_id, customer_id ON %I FOR EACH ROW EXECUTE FUNCTION fdp_assert_device_customer()',
      table_name || '_device_customer_consistency',
      table_name
    );
  END LOOP;
END;
$$;
