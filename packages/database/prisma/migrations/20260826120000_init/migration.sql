-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sites" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    "subregion" TEXT,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_email" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "cognito_sub" TEXT,
    "status" TEXT NOT NULL DEFAULT 'INVITED',
    "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" TEXT NOT NULL,
    "role_code" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_code")
);

-- CreateTable
CREATE TABLE "user_scopes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "site_id" TEXT,

    CONSTRAINT "user_scopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "hardware_version" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "manufacture_date" DATE NOT NULL,
    "alias" TEXT,
    "customer_id" TEXT,
    "site_id" TEXT,
    "lifecycle_status" TEXT NOT NULL DEFAULT 'PendingOnboarding',
    "firmware_version" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_assignments" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "site_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assigned_by" TEXT NOT NULL,
    "reason" TEXT,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "device_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_state_history" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_state_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "used_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "onboarding_requests" (
    "id" TEXT NOT NULL,
    "token_id" TEXT NOT NULL,
    "serial_number" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "hardware_version" TEXT NOT NULL,
    "manufacturer" TEXT NOT NULL,
    "manufacture_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reject_reason" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "onboarding_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_certificates" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_CLAIM',
    "certificate_pem" TEXT,
    "package_ciphertext" BYTEA,
    "package_kms_key_id" TEXT,
    "package_expires_at" TIMESTAMPTZ,
    "claimed_at" TIMESTAMPTZ,
    "not_before" TIMESTAMPTZ NOT NULL,
    "not_after" TIMESTAMPTZ NOT NULL,
    "rotated_from_id" TEXT,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_certificates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contracts" (
    "id" TEXT NOT NULL,
    "contract_number" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "contact" TEXT,
    "start_at" TIMESTAMPTZ NOT NULL,
    "end_at" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "contracts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contract_devices" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_to" TIMESTAMPTZ,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMPTZ,

    CONSTRAINT "contract_devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "licenses" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "valid_from" TIMESTAMPTZ NOT NULL,
    "valid_to" TIMESTAMPTZ NOT NULL,
    "signature" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "licenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_entitlements" (
    "id" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "license_entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "license_history" (
    "id" TEXT NOT NULL,
    "license_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "actor_id" TEXT,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "license_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_configurations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "target_model" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuration_versions" (
    "id" TEXT NOT NULL,
    "configuration_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "effective_at" TIMESTAMPTZ,
    "change_note" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "configuration_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_users" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "display_name" TEXT,
    "verifier_value" TEXT NOT NULL,
    "verifier_salt" TEXT NOT NULL,
    "verifier_kdf" TEXT,
    "verifier_version" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "device_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_user_assignments" (
    "id" TEXT NOT NULL,
    "device_user_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "device_user_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_latest_state" (
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "connectivity" TEXT,
    "operational_status" TEXT,
    "machine_running" BOOLEAN,
    "machine_mode" TEXT,
    "firmware_version" TEXT,
    "license_status" TEXT,
    "license_expiry_date" TIMESTAMPTZ,
    "network_type" TEXT,
    "network_status" TEXT,
    "signal_strength" INTEGER,
    "cpu_usage_pct" DECIMAL(5,2),
    "memory_usage_pct" DECIMAL(5,2),
    "storage_usage_pct" DECIMAL(5,2),
    "sensor_status" JSONB,
    "certificate_status" TEXT,
    "tamper_status" TEXT,
    "uptime_seconds" INTEGER,
    "last_heartbeat_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "device_latest_state_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "telemetry_hourly" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "bucket_start" TIMESTAMPTZ NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "completeness_pct" DECIMAL(5,2),
    "metrics" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_hourly_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "telemetry_daily" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "bucket_date" DATE NOT NULL,
    "sample_count" INTEGER NOT NULL,
    "completeness_pct" DECIMAL(5,2),
    "metrics" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "telemetry_daily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumable_projections" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "consumable_type" TEXT NOT NULL,
    "remaining_percent" INTEGER,
    "source_message_id" TEXT,
    "observed_at" TIMESTAMPTZ,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "consumable_projections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consumable_requests" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "consumable_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'ADMIN',
    "requested_by" TEXT NOT NULL,
    "requested_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_by" TEXT,
    "process_note" TEXT,
    "completed_at" TIMESTAMPTZ,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "consumable_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esg_calculation_versions" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "formula" JSONB,
    "effective_from" TIMESTAMPTZ NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esg_calculation_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esg_reports" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "report_type" TEXT NOT NULL,
    "period_start_time" TIMESTAMPTZ NOT NULL,
    "period_end_time" TIMESTAMPTZ NOT NULL,
    "feeding_weight_kg" DECIMAL(12,3),
    "discharge_weight_kg" DECIMAL(12,3),
    "reduction_weight_kg" DECIMAL(12,3),
    "cycle_count" INTEGER,
    "processing_minutes" INTEGER,
    "power_consumption_kwh" DECIMAL(12,3),
    "avg_power_kw" DECIMAL(10,3),
    "avg_o2_pct" DECIMAL(5,2),
    "avg_co2_ppm" DECIMAL(10,2),
    "avg_ch4_ppm" DECIMAL(10,2),
    "avg_n2o_ppm" DECIMAL(10,2),
    "carbon_reduction_kg" DECIMAL(12,3),
    "carbon_reduction_method" TEXT,
    "data_completeness_pct" DECIMAL(5,2),
    "missing_record_count" INTEGER,
    "calculation_version_id" TEXT,
    "source_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esg_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "esg_daily_summary" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "summary_date" DATE NOT NULL,
    "feeding_weight_kg" DECIMAL(12,3),
    "discharge_weight_kg" DECIMAL(12,3),
    "reduction_weight_kg" DECIMAL(12,3),
    "power_consumption_kwh" DECIMAL(12,3),
    "carbon_reduction_kg" DECIMAL(12,3),
    "data_completeness_pct" DECIMAL(5,2),
    "missing_record_count" INTEGER,
    "calculation_version_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "esg_daily_summary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alarms" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "detected_time" TIMESTAMPTZ NOT NULL,
    "component" TEXT,
    "current_value" TEXT,
    "threshold" TEXT,
    "unit" TEXT,
    "message" TEXT,
    "recommended_action" TEXT,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMPTZ,
    "cleared_at" TIMESTAMPTZ,
    "source_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "alarms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_events" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "user_id" TEXT,
    "username" TEXT,
    "source" TEXT,
    "remarks" TEXT,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "source_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tamper_events" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "component" TEXT,
    "details" JSONB,
    "action_taken" TEXT,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "source_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tamper_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_commands" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "command" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "high_risk" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "requested_by" TEXT NOT NULL,
    "request_time" TIMESTAMPTZ NOT NULL,
    "timeout_sec" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "remarks" TEXT,
    "confirmed_by" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_attempts" (
    "id" TEXT NOT NULL,
    "command_id" TEXT NOT NULL,
    "attempt_no" INTEGER NOT NULL,
    "published_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "command_acks" (
    "id" TEXT NOT NULL,
    "command_id" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "execute_time_ms" INTEGER,
    "error_code" TEXT,
    "message" TEXT,
    "ack_at" TIMESTAMPTZ NOT NULL,
    "source_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "command_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "firmware_packages" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "package_type" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "s3_key" TEXT NOT NULL,
    "signature" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UPLOADED',
    "uploaded_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "firmware_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ota_campaigns" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "package_id" TEXT NOT NULL,
    "target_model" TEXT NOT NULL,
    "strategy" TEXT NOT NULL DEFAULT 'CANARY',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ota_campaigns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ota_targets" (
    "id" TEXT NOT NULL,
    "campaign_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "batch_no" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduled_time" TIMESTAMPTZ,
    "completed_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "ota_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ota_status_history" (
    "id" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ota_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_upload_sessions" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "media_type" TEXT NOT NULL,
    "file_name" TEXT NOT NULL,
    "size_kb" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "presigned_url_expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "media_upload_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_objects" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "upload_session_id" TEXT,
    "media_type" TEXT NOT NULL,
    "capture_time" TIMESTAMPTZ NOT NULL,
    "file_name" TEXT NOT NULL,
    "object_path" TEXT NOT NULL,
    "size_kb" INTEGER NOT NULL,
    "duration_sec" INTEGER,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "source_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_objects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_receipts" (
    "id" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "topic_type" TEXT NOT NULL,
    "seq" INTEGER,
    "payload_hash" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "ingestion_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_gaps" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "topic_type" TEXT NOT NULL,
    "expected_seq" INTEGER NOT NULL,
    "received_seq" INTEGER NOT NULL,
    "detected_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ,

    CONSTRAINT "ingestion_gaps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_events" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "published_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "replay_jobs" (
    "id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "scope" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "result_summary" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,

    CONSTRAINT "replay_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "actor_role" TEXT,
    "customer_id" TEXT,
    "object_type" TEXT NOT NULL,
    "object_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "before_value" JSONB,
    "after_value" JSONB,
    "ip" TEXT,
    "user_agent" TEXT,
    "result" TEXT NOT NULL,
    "request_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sites_customer_id_name_key" ON "sites"("customer_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_cognito_sub_key" ON "users"("cognito_sub");

-- CreateIndex
CREATE UNIQUE INDEX "devices_serial_number_key" ON "devices"("serial_number");

-- CreateIndex
CREATE INDEX "device_state_history_device_id_created_at_idx" ON "device_state_history"("device_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_tokens_token_hash_key" ON "onboarding_tokens"("token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_requests_token_id_key" ON "onboarding_requests"("token_id");

-- CreateIndex
CREATE UNIQUE INDEX "device_certificates_fingerprint_key" ON "device_certificates"("fingerprint");

-- CreateIndex
CREATE INDEX "device_certificates_device_id_status_idx" ON "device_certificates"("device_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "contracts_contract_number_key" ON "contracts"("contract_number");

-- CreateIndex
CREATE INDEX "contract_devices_device_id_status_idx" ON "contract_devices"("device_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "license_entitlements_license_id_code_key" ON "license_entitlements"("license_id", "code");

-- CreateIndex
CREATE INDEX "license_history_license_id_created_at_idx" ON "license_history"("license_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "configuration_versions_configuration_id_version_key" ON "configuration_versions"("configuration_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "device_users_customer_id_username_key" ON "device_users"("customer_id", "username");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_hourly_device_id_bucket_start_key" ON "telemetry_hourly"("device_id", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "telemetry_daily_device_id_bucket_date_key" ON "telemetry_daily"("device_id", "bucket_date");

-- CreateIndex
CREATE UNIQUE INDEX "consumable_projections_device_id_consumable_type_key" ON "consumable_projections"("device_id", "consumable_type");

-- CreateIndex
CREATE UNIQUE INDEX "esg_calculation_versions_version_key" ON "esg_calculation_versions"("version");

-- CreateIndex
CREATE UNIQUE INDEX "esg_reports_source_message_id_key" ON "esg_reports"("source_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "esg_reports_device_id_report_type_period_start_time_key" ON "esg_reports"("device_id", "report_type", "period_start_time");

-- CreateIndex
CREATE UNIQUE INDEX "esg_daily_summary_device_id_summary_date_key" ON "esg_daily_summary"("device_id", "summary_date");

-- CreateIndex
CREATE UNIQUE INDEX "alarms_source_message_id_key" ON "alarms"("source_message_id");

-- CreateIndex
CREATE INDEX "alarms_customer_id_severity_status_idx" ON "alarms"("customer_id", "severity", "status");

-- CreateIndex
CREATE INDEX "alarms_device_id_detected_time_idx" ON "alarms"("device_id", "detected_time");

-- CreateIndex
CREATE UNIQUE INDEX "device_events_source_message_id_key" ON "device_events"("source_message_id");

-- CreateIndex
CREATE INDEX "device_events_device_id_occurred_at_idx" ON "device_events"("device_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "tamper_events_source_message_id_key" ON "tamper_events"("source_message_id");

-- CreateIndex
CREATE INDEX "tamper_events_device_id_occurred_at_idx" ON "tamper_events"("device_id", "occurred_at");

-- CreateIndex
CREATE INDEX "device_commands_device_id_status_idx" ON "device_commands"("device_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "command_attempts_command_id_attempt_no_key" ON "command_attempts"("command_id", "attempt_no");

-- CreateIndex
CREATE UNIQUE INDEX "command_acks_source_message_id_key" ON "command_acks"("source_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "firmware_packages_sha256_key" ON "firmware_packages"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "firmware_packages_model_version_package_type_key" ON "firmware_packages"("model", "version", "package_type");

-- CreateIndex
CREATE UNIQUE INDEX "ota_targets_campaign_id_device_id_key" ON "ota_targets"("campaign_id", "device_id");

-- CreateIndex
CREATE INDEX "ota_status_history_target_id_created_at_idx" ON "ota_status_history"("target_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "media_objects_upload_session_id_key" ON "media_objects"("upload_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_objects_source_message_id_key" ON "media_objects"("source_message_id");

-- CreateIndex
CREATE INDEX "media_objects_device_id_capture_time_idx" ON "media_objects"("device_id", "capture_time");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_receipts_idempotency_key_key" ON "ingestion_receipts"("idempotency_key");

-- CreateIndex
CREATE INDEX "ingestion_gaps_device_id_topic_type_detected_at_idx" ON "ingestion_gaps"("device_id", "topic_type", "detected_at");

-- CreateIndex
CREATE INDEX "outbox_events_status_created_at_idx" ON "outbox_events"("status", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_customer_id_created_at_idx" ON "audit_logs"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_object_type_object_id_idx" ON "audit_logs"("object_type", "object_id");

-- AddForeignKey
ALTER TABLE "sites" ADD CONSTRAINT "sites_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_code_fkey" FOREIGN KEY ("role_code") REFERENCES "roles"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_scopes" ADD CONSTRAINT "user_scopes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_state_history" ADD CONSTRAINT "device_state_history_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "onboarding_requests" ADD CONSTRAINT "onboarding_requests_token_id_fkey" FOREIGN KEY ("token_id") REFERENCES "onboarding_tokens"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_certificates" ADD CONSTRAINT "device_certificates_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contract_devices" ADD CONSTRAINT "contract_devices_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_entitlements" ADD CONSTRAINT "license_entitlements_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "license_history" ADD CONSTRAINT "license_history_license_id_fkey" FOREIGN KEY ("license_id") REFERENCES "licenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "configuration_versions" ADD CONSTRAINT "configuration_versions_configuration_id_fkey" FOREIGN KEY ("configuration_id") REFERENCES "device_configurations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_user_assignments" ADD CONSTRAINT "device_user_assignments_device_user_id_fkey" FOREIGN KEY ("device_user_id") REFERENCES "device_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_latest_state" ADD CONSTRAINT "device_latest_state_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esg_reports" ADD CONSTRAINT "esg_reports_calculation_version_id_fkey" FOREIGN KEY ("calculation_version_id") REFERENCES "esg_calculation_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "esg_daily_summary" ADD CONSTRAINT "esg_daily_summary_calculation_version_id_fkey" FOREIGN KEY ("calculation_version_id") REFERENCES "esg_calculation_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_attempts" ADD CONSTRAINT "command_attempts_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "device_commands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "command_acks" ADD CONSTRAINT "command_acks_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "device_commands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_campaigns" ADD CONSTRAINT "ota_campaigns_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "firmware_packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_targets" ADD CONSTRAINT "ota_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "ota_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ota_status_history" ADD CONSTRAINT "ota_status_history_target_id_fkey" FOREIGN KEY ("target_id") REFERENCES "ota_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_objects" ADD CONSTRAINT "media_objects_upload_session_id_fkey" FOREIGN KEY ("upload_session_id") REFERENCES "media_upload_sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =====================================================================
-- DB-01 自定义约束（Prisma Schema 无法表达，手工维护）
-- 1. 每设备仅一个有效许可证（Issued/Active/ExpiringSoon 视为有效）
-- 2. 每设备仅一条 ACTIVE 分配、一条 ACTIVE 设备用户授权
-- 3. 同设备有效 Contract 关联时间段不重叠（排他约束，btree_gist）
-- 4. 同序列号仅一条 PENDING Onboarding 申请
-- 5. 业务 CHECK：合约区间、耗材类型/百分比、耗材请求状态机
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- 1. 一个设备同一时间只允许一个有效许可证
CREATE UNIQUE INDEX "licenses_one_valid_per_device"
    ON "licenses" ("device_id")
    WHERE "status" IN ('Issued', 'Active', 'ExpiringSoon');

-- 2a. 一个设备同一时间仅一条 ACTIVE 分配
CREATE UNIQUE INDEX "device_assignments_one_active"
    ON "device_assignments" ("device_id")
    WHERE "status" = 'ACTIVE';

-- 2b. 同设备同设备用户仅一条 ACTIVE 授权
CREATE UNIQUE INDEX "device_user_assignments_one_active"
    ON "device_user_assignments" ("device_id", "device_user_id")
    WHERE "status" = 'ACTIVE';

-- 3. 同设备有效 Contract 关联时间段不重叠（valid_to 为 NULL 表示无限期）
ALTER TABLE "contract_devices"
    ADD CONSTRAINT "contract_devices_no_overlap"
    EXCLUDE USING gist (
        "device_id" WITH =,
        tstzrange("valid_from", "valid_to", '[)') WITH &&
    ) WHERE ("status" = 'ACTIVE');

-- 4. 同序列号仅一条 PENDING Onboarding 申请
CREATE UNIQUE INDEX "onboarding_requests_one_pending_per_serial"
    ON "onboarding_requests" ("serial_number")
    WHERE "status" = 'PENDING';

-- 5a. 合约生效区间必须 startAt < endAt
ALTER TABLE "contracts"
    ADD CONSTRAINT "contracts_valid_period" CHECK ("start_at" < "end_at");

-- 5b. 耗材类型封闭集合（DEC-008）；百分比仅保存设备上报值且限定 0~100
ALTER TABLE "consumable_projections"
    ADD CONSTRAINT "consumable_projections_type" CHECK ("consumable_type" IN ('CARBON_FILTER', 'BIO_ADDITIVE')),
    ADD CONSTRAINT "consumable_projections_percent" CHECK ("remaining_percent" IS NULL OR "remaining_percent" BETWEEN 0 AND 100);

ALTER TABLE "consumable_requests"
    ADD CONSTRAINT "consumable_requests_type" CHECK ("consumable_type" IN ('CARBON_FILTER', 'BIO_ADDITIVE')),
    ADD CONSTRAINT "consumable_requests_status" CHECK ("status" IN ('PENDING', 'PROCESSING', 'COMPLETED', 'CANCELLED'));
