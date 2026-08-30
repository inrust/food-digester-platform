-- BE-CNS-01：consumable_projections.customer_id 允许 NULL（设备可能尚未分配 Customer，投影仍可保存）；
-- customerId 为冗余查询列，镜像 devices.customer_id 的可空性。

ALTER TABLE "consumable_projections" ALTER COLUMN "customer_id" DROP NOT NULL;
