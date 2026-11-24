CREATE TABLE "configuration_deliveries" (
    "id" TEXT PRIMARY KEY,
    "device_id" TEXT NOT NULL REFERENCES "devices" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "configuration_version_id" TEXT NOT NULL REFERENCES "configuration_versions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    "served_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ,
    "applied_at" TIMESTAMPTZ,
    CONSTRAINT "configuration_deliveries_applied_requires_receipt" CHECK ("applied_at" IS NULL OR "received_at" IS NOT NULL)
);

CREATE INDEX "configuration_deliveries_version_device_served_idx"
ON "configuration_deliveries" ("configuration_version_id", "device_id", "served_at");
