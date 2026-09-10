/**
 * FE-05 通用模态框：表单类对话框容器（ConfirmDialog 语义不同，不共用）。
 * Esc 关闭；打开时焦点进入对话框，关闭后焦点回收至原聚焦元素。
 */
import { createPortal } from 'react-dom';
import { useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { useDialogA11y } from './dialog-a11y.js';

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testid?: string;
}

export function Modal({ open, title, onClose, children, testid }: ModalProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useDialogA11y(open, dialogRef, overlayRef, () => onCloseRef.current());

  if (!open) return null;

  return createPortal(
    <div className="dialog-overlay" ref={overlayRef}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-dialog"
        data-testid={testid ?? 'modal'}
        ref={dialogRef}
        tabIndex={-1}
      >
        <h3 id={titleId}>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  );
}
