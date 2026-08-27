/**
 * BE-ONB-01 Onboarding Request Service（业务核心，框架无关）。
 *
 * 校验链（顺序即语义）：
 * 1. 字段校验（VALIDATION_FAILED 400）；
 * 2. 幂等重放：同序列号已有 PENDING 申请 → 原样返回原 request（replayed=true）；
 * 3. 库存授权：序列号必须存在于设备库存（NOT_FOUND 404）；
 * 4. 设备状态：仅 PendingOnboarding 允许提交；已 Onboarded 等 → DEVICE_STATE_NOT_ALLOWED 409；
 * 5. 创建 PENDING 记录；并发唯一冲突（P2002）→ 回读既有记录幂等返回。
 *
 * 功能边界：不审批、不签发证书、不调用任何 AWS 服务（纯数据库读写）。
 */
import type { DbClient } from '@fdp/database';
import type { OnboardingAuthContext } from '@fdp/auth';
import { deviceStateNotAllowed, OnboardingApiError, serialNumberNotFound } from './errors.js';
import { parseOnboardingRequestBody } from './dto.js';
import type { OnboardingRequestBody } from './dto.js';
import { createOnboardingRequest, findPendingOnboardingRequest, isUniqueViolation } from './repository.js';
import type { OnboardingRequestRecord } from './repository.js';

export interface OnboardingRequestResult {
  readonly requestId: string;
  readonly status: 'PENDING';
  readonly serialNumber: string;
  readonly createdAt: Date;
  /** true 表示重复/并发提交的幂等重放（返回原 request，未新建记录）。 */
  readonly replayed: boolean;
}

interface DeviceInventoryDelegate {
  findFirst(args: { where: Record<string, unknown> }): Promise<{ id: string; lifecycleStatus: string } | null>;
}

function devices(client: DbClient): DeviceInventoryDelegate {
  return (client as unknown as Record<string, unknown>).device as DeviceInventoryDelegate;
}

function toResult(record: OnboardingRequestRecord, replayed: boolean): OnboardingRequestResult {
  return {
    requestId: record.id,
    status: 'PENDING',
    serialNumber: record.serialNumber,
    createdAt: record.createdAt,
    replayed,
  };
}

export interface SubmitOnboardingRequestOptions {
  /** 注入时钟（测试用），默认当前时间。 */
  readonly now?: () => Date;
}

export async function submitOnboardingRequest(
  client: DbClient,
  auth: OnboardingAuthContext,
  rawBody: unknown,
  options: SubmitOnboardingRequestOptions = {},
): Promise<OnboardingRequestResult> {
  const now = options.now?.() ?? new Date();
  const input: OnboardingRequestBody = parseOnboardingRequestBody(rawBody, now);

  // Guard 已保证 Token 与 serialNumber 绑定；此处以认证上下文为准再断言一次（防绕过直连 Service）
  if (input.serialNumber !== auth.serialNumber) {
    throw new OnboardingApiError('VALIDATION_FAILED', 'serialNumber does not match the credential');
  }

  // 幂等重放优先：重复提交一律返回原 request
  const existing = await findPendingOnboardingRequest(client, input.serialNumber);
  if (existing) return toResult(existing, true);

  const inventory = await devices(client).findFirst({ where: { serialNumber: input.serialNumber } });
  if (!inventory) throw serialNumberNotFound();
  if (inventory.lifecycleStatus !== 'PendingOnboarding') throw deviceStateNotAllowed();

  try {
    const created = await createOnboardingRequest(client, {
      tokenId: auth.tokenId,
      serialNumber: input.serialNumber,
      model: input.model,
      hardwareVersion: input.hardwareVersion,
      manufacturer: input.manufacturer,
      manufactureDate: input.manufactureDate,
    });
    return toResult(created, false);
  } catch (err) {
    // 并发重复提交：唯一索引兜底，回读胜出方记录幂等返回
    if (!isUniqueViolation(err)) throw err;
    const winner = await findPendingOnboardingRequest(client, input.serialNumber);
    if (winner) return toResult(winner, true);
    throw err;
  }
}
