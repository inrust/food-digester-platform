-- CMP-23: forward and backward keyset scans for platform and customer media lists.
CREATE INDEX "media_objects_capture_time_id_idx" ON "media_objects"("capture_time", "id");
CREATE INDEX "media_objects_customer_id_capture_time_id_idx" ON "media_objects"("customer_id", "capture_time", "id");
