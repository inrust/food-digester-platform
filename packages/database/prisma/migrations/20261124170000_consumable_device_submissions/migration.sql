CREATE TABLE "consumable_device_submissions" (
    "device_id" TEXT NOT NULL,
    "request_key" TEXT NOT NULL,
    "request_id" TEXT NOT NULL REFERENCES "consumable_requests" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "assignment_id" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("device_id", "request_key")
);

CREATE INDEX "consumable_device_submissions_request_id_idx" ON "consumable_device_submissions" ("request_id");
