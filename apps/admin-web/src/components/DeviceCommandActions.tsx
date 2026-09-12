import { translate } from '../i18n/i18n.js';
/**
 * FE-03 设备快捷命令按钮组（卡片级；FE-12 命令页复用同一组件语义）。
 *
 * - 白名单：只渲染 QUICK_COMMANDS（START/STOP/REBOOT），服务端 actions 缺失按 UNKNOWN_COMMAND 禁用；
 * - 确认：提交前经 ConfirmDialog（不使用浏览器原生确认）；
 * - 结果：提交成功后显示“已受理，等待设备执行（Pending）”，绝不显示“成功”；
 * - denyReason（服务端状态门/权限）必须展示在按钮旁。
 */
import { useState } from 'react';
import { ApiClientError } from '../api/errors.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DENY_REASON_LABELS, QUICK_COMMANDS, quickActionsOf } from '../pages/dashboard/dashboard-state.js';
import type { CommandActionView } from '../pages/dashboard/types.js';
export interface CommandSubmitResult {
  readonly commandId: string;
  /** 服务端命令记录状态（创建即 AUTHORIZED）；页面统一按 Pending 语义展示。 */
  readonly status: string;
}
export interface DeviceCommandActionsProps {
  readonly deviceId: string;
  readonly actions: readonly CommandActionView[];
  readonly onSubmit: (deviceId: string, command: string) => Promise<CommandSubmitResult>;
}
export function DeviceCommandActions({ deviceId, actions, onSubmit }: DeviceCommandActionsProps) {
  const [pendingCommand, setPendingCommand] = useState<{
    command: string;
    label: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{
    command: string;
    commandId: string;
  } | null>(null);
  const [submitError, setSubmitError] = useState<{
    message: string;
    code: string | null;
    requestId: string | null;
  } | null>(null);
  const models = quickActionsOf(actions);
  const pendingLabel = QUICK_COMMANDS.find((c) => c.command === pendingCommand?.command)?.label;
  const confirm = async () => {
    if (pendingCommand === null) return;
    const { command } = pendingCommand;
    setPendingCommand(null);
    setSubmitting(true);
    setSubmitError(null);
    setResult(null);
    try {
      const submitted = await onSubmit(deviceId, command);
      setResult({ command, commandId: submitted.commandId });
    } catch (err) {
      setSubmitError(
        err instanceof ApiClientError
          ? { message: err.message, code: err.code, requestId: err.requestId }
          : { message: translate('ui.e6b638b53945'), code: null, requestId: null },
      );
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <div className="device-command-actions" data-testid={`command-actions-${deviceId}`}>
      <div className="action-buttons">
        {models.map((model) => (
          <span key={model.command} className="action-item">
            <button
              type="button"
              data-testid={`action-${model.command}-${deviceId}`}
              disabled={!model.allowed || submitting}
              onClick={() => setPendingCommand({ command: model.command, label: model.label })}
            >
              {model.label}
            </button>
            {!model.allowed && model.denyReason !== null ? (
              <span className="deny-reason" data-testid={`deny-${model.command}-${deviceId}`}>
                {DENY_REASON_LABELS[model.denyReason]}
              </span>
            ) : null}
          </span>
        ))}
      </div>

      {result !== null ? (
        <p className="command-result" role="status" data-testid={`command-result-${deviceId}`}>
          {translate('page.97a167d1d8ec')}
          {result.commandId}
          {translate('ui.2c0baf8ce2a9')}
        </p>
      ) : null}
      {submitError !== null ? (
        <p className="command-error" role="alert" data-testid={`command-error-${deviceId}`}>
          {translate('ui.84875f33e1a1')}
          {submitError.message}
          {submitError.code !== null ? translate('ui.8303c6e64eb9') + submitError.code + '\uFF09' : ''}
          {submitError.requestId !== null ? `（requestId：${submitError.requestId}）` : ''}
        </p>
      ) : null}

      <ConfirmDialog
        open={pendingCommand !== null}
        title={translate('page.b56d9ac6c5a0') + (pendingLabel ?? '')}
        description={translate('ui.80415e0eb792') + ' ' + deviceId + translate('ui.15364650595e')}
        confirmText={translate('ui.00bb4a6304c0')}
        onConfirm={() => void confirm()}
        onCancel={() => setPendingCommand(null)}
      />
    </div>
  );
}
