import { Button, TextArea } from './ui.js';
/**
 * FE-02 危险操作确认模态框（替代浏览器原生 confirm）。
 *
 * - 明确的确认/取消按钮；danger 样式标识高危操作；
 * - requireReason 时必须填写原因（默认至少 1 个非空字符），标签经 htmlFor 关联；
 * - Esc 取消；打开时焦点进入对话框，关闭后焦点回收到原聚焦元素。
 */
import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState } from 'react';
import { useDialogA11y } from './dialog-a11y.js';
import { useI18n } from '../i18n/i18n.js';

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
  reasonLabel,
  confirmText,
  cancelText,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const resolvedReasonLabel = reasonLabel ?? t('common.reason');
  const resolvedConfirmText = confirmText ?? t('common.confirm');
  const resolvedCancelText = cancelText ?? t('common.cancel');
  const [reason, setReason] = useState('');
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const reasonRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
  const reasonId = useId();
  const hintId = useId();
  const initialFocusRef = requireReason ? reasonRef : cancelRef;
  useDialogA11y(open, dialogRef, overlayRef, onCancel, initialFocusRef);

  // 重新打开时重置原因输入
  useEffect(() => {
    if (open) setReason('');
  }, [open]);

  if (!open) return null;

  const reasonMissing = requireReason && reason.trim().length === 0;

  return createPortal(
    <div className="dialog-overlay" data-testid="dialog-overlay" ref={overlayRef}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`confirm-dialog${danger ? ' danger' : ''}`}
        data-testid="confirm-dialog"
        ref={dialogRef}
        tabIndex={-1}
      >
        <h3 id={titleId}>{title}</h3>
        {description !== undefined ? <p className="dialog-description">{description}</p> : null}
        {requireReason ? (
          <div className="dialog-field">
            <label htmlFor={reasonId}>{resolvedReasonLabel}</label>
            <TextArea
              id={reasonId}
              ref={reasonRef}
              value={reason}
              aria-describedby={hintId}
              onChange={(event) => setReason(event.target.value)}
            />
            <p id={hintId} className="field-hint">
              {t('common.reasonHint')}
            </p>
          </div>
        ) : null}
        <div className="dialog-actions">
          <Button type="button" ref={cancelRef} onClick={onCancel}>
            {resolvedCancelText}
          </Button>
          <Button
            type="button"
            className={danger ? 'danger-button' : 'primary-button'}
            disabled={reasonMissing}
            onClick={() => onConfirm(reason.trim())}
          >
            {resolvedConfirmText}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
