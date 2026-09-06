/**
 * FE-02 危险操作确认模态框（替代浏览器原生 confirm）。
 *
 * - 明确的确认/取消按钮；danger 样式标识高危操作；
 * - requireReason 时必须填写原因（默认至少 1 个非空字符），标签经 htmlFor 关联；
 * - Esc 取消；打开时焦点进入对话框，关闭后焦点回收到原聚焦元素。
 */
import { useEffect, useRef, useState } from 'react';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly danger?: boolean;
  readonly requireReason?: boolean;
  readonly reasonLabel?: string;
  readonly confirmText?: string;
  readonly cancelText?: string;
  readonly onConfirm: (reason: string) => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  danger = false,
  requireReason = false,
  reasonLabel = '操作原因',
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [reason, setReason] = useState('');
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const titleId = 'confirm-dialog-title';
  const reasonId = 'confirm-dialog-reason';
  const hintId = 'confirm-dialog-reason-hint';

  // 焦点管理：打开时进对话框，关闭时回原聚焦元素；Esc 取消
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, onCancel]);

  // 重新打开时重置原因输入
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  if (!open) return null;

  const reasonMissing = requireReason && reason.trim().length === 0;

  return (
    <div className="dialog-overlay" data-testid="dialog-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`confirm-dialog${danger ? ' danger' : ''}`}
        data-testid="confirm-dialog"
      >
        <h3 id={titleId}>{title}</h3>
        {description !== undefined ? <p className="dialog-description">{description}</p> : null}
        {requireReason ? (
          <div className="dialog-field">
            <label htmlFor={reasonId}>{reasonLabel}</label>
            <textarea
              id={reasonId}
              value={reason}
              aria-describedby={hintId}
              onChange={(event) => setReason(event.target.value)}
            />
            <p id={hintId} className="field-hint">
              必填，将写入审计记录
            </p>
          </div>
        ) : null}
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={danger ? 'danger-button' : 'primary-button'}
            disabled={reasonMissing}
            onClick={() => onConfirm(reason.trim())}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
