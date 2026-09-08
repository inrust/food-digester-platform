/**
 * FE-05 通用模态框：表单类对话框容器（ConfirmDialog 语义不同，不共用）。
 * Esc 关闭；打开时焦点进入对话框，关闭后焦点回收至原聚焦元素。
 */
import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

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
  // onClose 经 ref 持有：父级内联回调身份每次渲染变化，不触发焦点回收/重置
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="dialog-overlay">
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
    </div>
  );
}
