-- BE-CNS-02：同设备同耗材同时至多一个开放申请（PENDING/PROCESSING）；
-- 服务层幂等返回现有记录，本部分唯一索引为并发兜底（冲突 → 重读返回现有记录）。

CREATE UNIQUE INDEX "consumable_requests_one_open_per_device_type"
    ON "consumable_requests" ("device_id", "consumable_type")
    WHERE "status" IN ('PENDING', 'PROCESSING');
