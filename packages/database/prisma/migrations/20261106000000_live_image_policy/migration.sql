-- IMG-08 authoritative server allowlist. Existing devices remain disabled.
CREATE TABLE "device_live_image_policies" (
  "device_id" TEXT NOT NULL PRIMARY KEY REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "enabled" BOOLEAN NOT NULL DEFAULT false
);
