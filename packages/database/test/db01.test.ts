/**
 * DB-01 验收测试：空库迁移 + 关键约束拒绝。
 * 运行真实 PostgreSQL（PGlite，WASM 内嵌），执行实际 migration.sql 与 seed.sql。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { readFileSync } from 'node:fs';
import { readAllMigrationSql } from './helpers.js';

const MIGRATION_SQL = readAllMigrationSql();
const SEED_SQL = readFileSync(new URL('../prisma/seed.sql', import.meta.url), 'utf8');

let db: PGlite;

/** 期望 SQL 执行被指定错误码拒绝（23505 唯一 / 23514 CHECK / 23P01 排他 / 23503 外键）。 */
async function expectRejected(sql: string, code: string, params: unknown[] = []) {
  try {
    await db.query(sql, params);
  } catch (err) {
    expect((err as { code?: string }).code, `应抛出 ${code}，实际 ${String(err)}`).toBe(code);
    return;
  }
  throw new Error(`应被拒绝（${code}）但执行成功：${sql}`);
}

async function insertDevice(id: string, serialNumber: string) {
  await db.query(
    `INSERT INTO "devices" ("id", "serial_number", "model", "hardware_version", "manufacturer", "manufacture_date", "lifecycle_status", "customer_id", "site_id", "created_at", "updated_at")
     VALUES ($1, $2, 'BNX-100', 'HW1.0', 'Hiddenjoy', '2026-01-01', 'Onboarded', 'cust-1', 'site-1', now(), now())`,
    [id, serialNumber],
  );
}

async function insertLicense(id: string, deviceId: string, status: string) {
  await db.query(
    `INSERT INTO "licenses" ("id", "device_id", "customer_id", "status", "valid_from", "valid_to", "created_by", "created_at", "updated_at")
     VALUES ($1, $2, 'cust-1', $3, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'admin-1', now(), now())`,
    [id, deviceId, status],
  );
}

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  await db.exec(MIGRATION_SQL); // 空库迁移
  await db.exec(`
    INSERT INTO "customers" ("id", "name", "created_at", "updated_at") VALUES
      ('cust-1', '客户一', now(), now()),
      ('cust-2', '客户二', now(), now());
    INSERT INTO "sites" ("id", "customer_id", "name", "created_at", "updated_at") VALUES
      ('site-1', 'cust-1', '站点一', now(), now()),
      ('site-2', 'cust-2', '站点二', now(), now());
  `);
}, 60_000);

afterAll(async () => {
  await db.close();
});

describe('空库迁移', () => {
  test('migration.sql 在空库执行成功，全部业务表建立', async () => {
    const { rows } = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(38);
  });

  test('无原始 Telemetry 长期表（仅聚合表）', async () => {
    const { rows } = await db.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name ILIKE '%telemetry%'`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(['telemetry_daily', 'telemetry_hourly']);
  });

  test('所有 Customer 业务表均含 customer_id 列', async () => {
    const REQUIRED = [
      'sites',
      'user_scopes',
      'devices',
      'device_assignments',
      'contracts',
      'contract_devices',
      'licenses',
      'device_users',
      'device_user_assignments',
      'telemetry_hourly',
      'telemetry_daily',
      'consumable_projections',
      'consumable_requests',
      'esg_reports',
      'esg_daily_summary',
      'alarms',
      'device_events',
      'tamper_events',
      'device_commands',
      'media_upload_sessions',
      'media_objects',
    ];
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'customer_id'`,
    );
    const present = new Set(rows.map((r) => r.table_name));
    for (const t of REQUIRED) expect(present.has(t), `${t} 缺少 customer_id`).toBe(true);
  });

  test('device_state_history 持久化封闭状态轴，未知 axis 被拒绝', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'device_state_history' AND column_name = 'axis'`,
    );
    expect(rows).toHaveLength(1);
    await insertDevice('dev-axis-1', 'SN-AXIS-1');
    await db.query(
      `INSERT INTO "device_state_history" ("id", "device_id", "axis", "from_status", "to_status", "actor_type")
       VALUES ('hist-axis-ok', 'dev-axis-1', 'lifecycle', 'Onboarded', 'Assigned', 'ADMIN')`,
    );
    await expectRejected(
      `INSERT INTO "device_state_history" ("id", "device_id", "axis", "from_status", "to_status", "actor_type")
       VALUES ('hist-axis-bad', 'dev-axis-1', 'mixed', 'Assigned', 'Active', 'ADMIN')`,
      '22P02',
    );
  });
});

describe('设备唯一性', () => {
  test('重复 deviceId 被拒绝', async () => {
    await insertDevice('dev-dup-1', 'SN-DUP-1');
    await expectRejected(
      `INSERT INTO "devices" ("id", "serial_number", "model", "hardware_version", "manufacturer", "manufacture_date", "lifecycle_status", "created_at", "updated_at")
       VALUES ('dev-dup-1', 'SN-OTHER', 'M', 'H', 'M', '2026-01-01', 'Onboarded', now(), now())`,
      '23505',
    );
  });

  test('重复 serialNumber 被拒绝', async () => {
    await expectRejected(
      `INSERT INTO "devices" ("id", "serial_number", "model", "hardware_version", "manufacturer", "manufacture_date", "lifecycle_status", "created_at", "updated_at")
       VALUES ('dev-dup-2', 'SN-DUP-1', 'M', 'H', 'M', '2026-01-01', 'Onboarded', now(), now())`,
      '23505',
    );
  });
});

describe('幂等键', () => {
  test('重复幂等键被拒绝（ingestion_receipts.idempotency_key 唯一）', async () => {
    const insert = `INSERT INTO "ingestion_receipts" ("id", "idempotency_key", "device_id", "topic_type", "payload_hash", "result")
                    VALUES ($1, 'dev-dup-1:telemetry:1', 'dev-dup-1', 'telemetry', 'sha256:abc', 'PROCESSED')`;
    await db.query(insert, ['rcpt-1']);
    await expectRejected(insert, '23505', ['rcpt-2']);
  });
});

describe('许可证唯一有效性', () => {
  test('一个设备不能同时存在两个有效许可证', async () => {
    await insertDevice('dev-lic-1', 'SN-LIC-1');
    await insertLicense('lic-1', 'dev-lic-1', 'Active');
    await expectRejected(
      `INSERT INTO "licenses" ("id", "device_id", "customer_id", "status", "valid_from", "valid_to", "created_by", "created_at", "updated_at")
       VALUES ('lic-2', 'dev-lic-1', 'cust-1', 'Issued', '2026-02-01T00:00:00Z', '2027-02-01T00:00:00Z', 'admin-1', now(), now())`,
      '23505',
    );
  });

  test('已撤销/草稿许可证不占用有效位（可重建 Draft）', async () => {
    await insertLicense('lic-3', 'dev-lic-1', 'Revoked');
    await insertLicense('lic-4', 'dev-lic-1', 'Draft');
  });

  test('Renewed 占用有效许可证唯一位，并发创建第二个有效 License 被拒绝', async () => {
    await insertDevice('dev-lic-renewed', 'SN-LIC-RENEWED');
    await db.query(
      `UPDATE "devices" SET "customer_id" = 'cust-1', "site_id" = 'site-1' WHERE "id" = 'dev-lic-renewed'`,
    );
    await insertLicense('lic-renewed', 'dev-lic-renewed', 'Renewed');
    await expectRejected(
      `INSERT INTO "licenses" ("id", "device_id", "customer_id", "status", "valid_from", "valid_to", "created_by", "created_at", "updated_at")
       VALUES ('lic-after-renewed', 'dev-lic-renewed', 'cust-1', 'Issued', '2026-02-01T00:00:00Z', '2027-02-01T00:00:00Z', 'admin-1', now(), now())`,
      '23505',
    );
  });
});

describe('Contract 关联不重叠', () => {
  test('同设备有效 Contract 关联时间段重叠被拒绝', async () => {
    await insertDevice('dev-con-1', 'SN-CON-1');
    await db.query(`UPDATE "devices" SET "customer_id" = 'cust-1', "site_id" = 'site-1' WHERE "id" = 'dev-con-1'`);
    for (const [id, num] of [
      ['con-1', 'C-2026-001'],
      ['con-2', 'C-2026-002'],
    ] as const) {
      await db.query(
        `INSERT INTO "contracts" ("id", "contract_number", "name", "customer_id", "start_at", "end_at", "created_by", "created_at", "updated_at")
         VALUES ($1, $2, '合约', 'cust-1', '2026-01-01T00:00:00Z', '2027-12-31T00:00:00Z', 'admin-1', now(), now())`,
        [id, num],
      );
    }
    await db.query(
      `INSERT INTO "contract_devices" ("id", "contract_id", "device_id", "customer_id", "valid_from", "valid_to", "status")
       VALUES ('cd-1', 'con-1', 'dev-con-1', 'cust-1', '2026-01-01T00:00:00Z', '2026-12-31T00:00:00Z', 'ACTIVE')`,
    );
    // 与 cd-1 时间段重叠
    await expectRejected(
      `INSERT INTO "contract_devices" ("id", "contract_id", "device_id", "customer_id", "valid_from", "valid_to", "status")
       VALUES ('cd-2', 'con-2', 'dev-con-1', 'cust-1', '2026-06-01T00:00:00Z', '2027-06-01T00:00:00Z', 'ACTIVE')`,
      '23P01',
    );
  });

  test('时间段不重叠或已结束的关联允许', async () => {
    // 不重叠
    await db.query(
      `INSERT INTO "contract_devices" ("id", "contract_id", "device_id", "customer_id", "valid_from", "valid_to", "status")
       VALUES ('cd-3', 'con-2', 'dev-con-1', 'cust-1', '2027-01-01T00:00:00Z', '2027-12-31T00:00:00Z', 'ACTIVE')`,
    );
    // 与 cd-1 重叠但已 ENDED
    await db.query(
      `INSERT INTO "contract_devices" ("id", "contract_id", "device_id", "customer_id", "valid_from", "valid_to", "status")
       VALUES ('cd-4', 'con-2', 'dev-con-1', 'cust-1', '2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z', 'ENDED')`,
    );
  });

  test('合约 startAt >= endAt 被 CHECK 拒绝', async () => {
    await expectRejected(
      `INSERT INTO "contracts" ("id", "contract_number", "name", "customer_id", "start_at", "end_at", "created_by", "created_at", "updated_at")
       VALUES ('con-bad', 'C-2026-BAD', '非法合约', 'cust-1', '2027-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'admin-1', now(), now())`,
      '23514',
    );
  });
});

describe('耗材约束（DEC-008 / BE-CNS-02）', () => {
  test('非法耗材请求状态被拒绝', async () => {
    await expectRejected(
      `INSERT INTO "consumable_requests" ("id", "customer_id", "device_id", "consumable_type", "status", "requested_by", "created_at", "updated_at")
       VALUES ('cr-bad', 'cust-1', 'dev-con-1', 'CARBON_FILTER', 'UNKNOWN_STATUS', 'admin-1', now(), now())`,
      '23514',
    );
  });

  test('非法耗材类型被拒绝', async () => {
    await expectRejected(
      `INSERT INTO "consumable_requests" ("id", "customer_id", "device_id", "consumable_type", "status", "requested_by", "created_at", "updated_at")
       VALUES ('cr-bad-2', 'cust-1', 'dev-con-1', 'MAGIC_POWDER', 'PENDING', 'admin-1', now(), now())`,
      '23514',
    );
  });

  test('合法请求通过；投影百分比超界被拒绝、未上报（NULL）允许', async () => {
    await db.query(
      `INSERT INTO "consumable_requests" ("id", "customer_id", "device_id", "consumable_type", "status", "requested_by", "created_at", "updated_at")
       VALUES ('cr-ok', 'cust-1', 'dev-con-1', 'CARBON_FILTER', 'PENDING', 'admin-1', now(), now())`,
    );
    await expectRejected(
      `INSERT INTO "consumable_projections" ("id", "device_id", "customer_id", "consumable_type", "remaining_percent", "updated_at")
       VALUES ('cp-bad', 'dev-con-1', 'cust-1', 'CARBON_FILTER', 120, now())`,
      '23514',
    );
    await db.query(
      `INSERT INTO "consumable_projections" ("id", "device_id", "customer_id", "consumable_type", "remaining_percent", "updated_at")
       VALUES ('cp-ok', 'dev-con-1', 'cust-1', 'CARBON_FILTER', NULL, now())`,
    );
  });
});

describe('外键与种子字典', () => {
  test('引用不存在 Customer 的 Site 被外键拒绝', async () => {
    await expectRejected(
      `INSERT INTO "sites" ("id", "customer_id", "name", "created_at", "updated_at")
       VALUES ('site-bad', 'cust-ghost', '幽灵站点', now(), now())`,
      '23503',
    );
  });

  test('Customer 业务表拒绝孤儿 customer_id', async () => {
    await insertDevice('dev-fk-orphan', 'SN-FK-ORPHAN');
    await expectRejected(
      `INSERT INTO "device_assignments" ("id", "device_id", "customer_id", "site_id", "status", "assigned_by")
       VALUES ('asg-orphan', 'dev-fk-orphan', 'cust-ghost', 'site-1', 'ACTIVE', 'admin-1')`,
      '23503',
    );
  });

  test('Device Assignment 拒绝跨 Customer 的 Site/Device 组合', async () => {
    await insertDevice('dev-fk-assignment', 'SN-FK-ASG');
    await db.query(
      `UPDATE "devices" SET "customer_id" = 'cust-1', "site_id" = 'site-1' WHERE "id" = 'dev-fk-assignment'`,
    );
    await expectRejected(
      `INSERT INTO "device_assignments" ("id", "device_id", "customer_id", "site_id", "status", "assigned_by")
       VALUES ('asg-cross', 'dev-fk-assignment', 'cust-2', 'site-2', 'ACTIVE', 'admin-1')`,
      '23514',
    );
  });

  test('ContractDevice 与 License 拒绝 customer_id 和父实体归属不一致', async () => {
    await insertDevice('dev-fk-commercial', 'SN-FK-COM');
    await db.query(
      `UPDATE "devices" SET "customer_id" = 'cust-1', "site_id" = 'site-1' WHERE "id" = 'dev-fk-commercial'`,
    );
    await db.query(
      `INSERT INTO "contracts" ("id", "contract_number", "name", "customer_id", "start_at", "end_at", "created_by", "created_at", "updated_at")
       VALUES ('con-fk', 'C-FK', '约束合约', 'cust-1', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'admin-1', now(), now())`,
    );
    await expectRejected(
      `INSERT INTO "contract_devices" ("id", "contract_id", "device_id", "customer_id", "valid_from", "status")
       VALUES ('cd-cross', 'con-fk', 'dev-fk-commercial', 'cust-2', '2026-01-01T00:00:00Z', 'ACTIVE')`,
      '23514',
    );
    await expectRejected(
      `INSERT INTO "licenses" ("id", "device_id", "customer_id", "status", "valid_from", "valid_to", "created_by", "created_at", "updated_at")
       VALUES ('lic-cross', 'dev-fk-commercial', 'cust-2', 'Issued', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'admin-1', now(), now())`,
      '23514',
    );
  });

  test('seed.sql 幂等：执行两次，角色 5 条、ESG 计算版本 1 条', async () => {
    await db.exec(SEED_SQL);
    await db.exec(SEED_SQL);
    const roles = await db.query<{ count: string }>(`SELECT count(*) AS count FROM "roles"`);
    expect(Number(roles.rows[0]!.count)).toBe(5);
    const versions = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM "esg_calculation_versions" WHERE "version" = '1.0.0'`,
    );
    expect(Number(versions.rows[0]!.count)).toBe(1);
  });
});
