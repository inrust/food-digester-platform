/**
 * BE-CMD-03 Command Timeout Evaluator（可注入时钟；框架无关）。
 *
 * 规则：
 * - 扫描范围：COMMAND_UNFINISHED_STATUSES（AUTHORIZED/PUBLISHING/PUBLISH_FAILED/PUBLISHED/ACKNOWLEDGED）
 *   且 expiresAt <= now → TIMED_OUT（expiresAt = requestTime + timeoutSec，BE-CMD-01 落库；
 *   PUBLISHING 滞留由本评估器兜底，见 BE-CMD-02 未决风险）；
 * - 每条迁移：条件 updateMany（并发漂移兜底，count!==1 跳过）+ 同事务 recordAudit 审计 command.timeout
 *   （actor=system；仅真实迁移成功才记审计）；迟到 ACK 由 ACK Handler 保存为事件但不回改（classifyAck EVENT_ONLY）；
 * - 功能边界：不负责定时器运维调度（由部署层周期调用本函数），不负责设备执行。
 */
import type { DbClient } from '@fdp/database';
import { recordAudit, withTransaction } from '@fdp/database';
import { COMMAND_UNFINISHED_STATUSES } from '@fdp/domain';

export interface TimeoutEvaluatorDeps {
  readonly client: DbClient;
  readonly now?: () => Date;
}

export interface TimeoutEvaluationResult {
  /** 本次被置为 TIMED_OUT 的 commandId 列表。 */
  readonly timedOut: string[];
}

interface CommandTimeoutRow {
  readonly id: string;
  readonly customerId: string;
  readonly status: string;
}

interface CommandTimeoutDelegate {
  findMany(args: Record<string, unknown>): Promise<CommandTimeoutRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}

function commands(client: DbClient): CommandTimeoutDelegate {
  return (client as unknown as Record<string, unknown>).deviceCommand as CommandTimeoutDelegate;
}

/** 将到期未完成命令置 TIMED_OUT；返回本次迁移的 commandId 列表（并发漂移被跳过的不计）。 */
export async function evaluateCommandTimeouts(deps: TimeoutEvaluatorDeps): Promise<TimeoutEvaluationResult> {
  const now = deps.now?.() ?? new Date();
  const overdue = await commands(deps.client).findMany({
    where: { status: { in: [...COMMAND_UNFINISHED_STATUSES] }, expiresAt: { lte: now } },
    select: { id: true, customerId: true, status: true },
  });
  const timedOut: string[] = [];
  for (const row of overdue) {
    // 条件更新（并发漂移兜底）：仅真实迁移成功才记审计（同一事务）
    const transitioned = await withTransaction(deps.client, async (tx) => {
      const { count } = await commands(tx).updateMany({
        where: { id: row.id, status: row.status },
        data: { status: 'TIMED_OUT' },
      });
      if (count !== 1) return false;
      await recordAudit(tx, {
        objectType: 'device_command',
        objectId: row.id,
        action: 'command.timeout',
        result: 'SUCCESS',
        actorId: 'system',
        actorRole: 'system',
        customerId: row.customerId,
        beforeValue: { status: row.status },
        afterValue: { status: 'TIMED_OUT' },
      });
      return true;
    });
    if (transitioned) timedOut.push(row.id);
  }
  return { timedOut };
}
