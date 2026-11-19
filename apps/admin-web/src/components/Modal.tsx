import { Modal as AntModal } from 'antd';
/**
 * FE-05 通用模态框：表单类对话框容器（ConfirmDialog 语义不同，不共用）。
 * Esc 关闭；打开时焦点进入对话框，关闭后焦点回收至原聚焦元素。
 */
import { createPortal } from 'react-dom';
import { useRef } from 'react';
import type { ReactNode } from 'react';
import { useDialogA11y } from './dialog-a11y.js';
import { useI18n } from '../i18n/i18n.js';

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testid?: string;
}

export function Modal({ open, title, onClose, children, testid }: ModalProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  useDialogA11y(open, dialogRef, overlayRef, onClose);

  if (!open) return null;

  return createPortal(
    <div className="library-dialog-overlay" ref={overlayRef}>
      <AntModal
        open
        centered
        getContainer={false}
        width={560}
        footer={null}
        closable={{ 'aria-label': t('common.close') }}
        onCancel={onClose}
        keyboard={false}
        mask={{ closable: false }}
        focusable={{ trap: false, focusTriggerAfterClose: false }}
        transitionName=""
        maskTransitionName=""
        title={<h3>{title}</h3>}
        className="fdp-modal"
        modalRender={(node) => (
          <div data-testid={testid ?? 'modal'} ref={dialogRef} tabIndex={-1}>
            {node}
          </div>
        )}
      >
        {children}
      </AntModal>
    </div>,
    document.body,
  );
}
