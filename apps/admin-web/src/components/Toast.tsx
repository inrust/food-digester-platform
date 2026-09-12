import { translate } from '../i18n/i18n.js';
/**
 * FE-02 Toast：轻量提示，info/success 自动消失，error 需手动关闭（含 code/requestId）。
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { toastReducer } from './toast-store.js';
import type { ToastItem, ToastKind } from './toast-store.js';
export const TOAST_AUTO_DISMISS_MS = 4000;
export interface ToastHostProps {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss: (id: number) => void;
}
export function ToastHost({ toasts, onDismiss }: ToastHostProps) {
  return (
    <div className="toast-host" data-testid="toast-host">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast toast-${toast.kind}`}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          data-testid={`toast-${toast.id}`}
        >
          <span className="toast-message">{toast.message}</span>
          {toast.code !== undefined ? (
            <span className="toast-code">
              {translate('ui.4b3e10411576')}
              {toast.code}
            </span>
          ) : null}
          {toast.requestId !== undefined ? (
            <span className="toast-request-id">requestId：{toast.requestId}</span>
          ) : null}
          <button
            type="button"
            aria-label={translate('ui.335447e2c3cf') + toast.message}
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
export interface ToastQueue {
  readonly toasts: readonly ToastItem[];
  readonly push: (
    kind: ToastKind,
    message: string,
    extra?: {
      code?: string;
      requestId?: string;
    },
  ) => number;
  readonly dismiss: (id: number) => void;
}
/** Toast 队列 Hook：自动消失计时由注入的 durationMs 控制（测试可传 0 关闭）。 */
export function useToastQueue(options?: { durationMs?: number }): ToastQueue {
  const durationMs = options?.durationMs ?? TOAST_AUTO_DISMISS_MS;
  const [toasts, dispatch] = useReducer(toastReducer, [] as ToastItem[]);
  const nextId = useRef(1);
  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), []);
  const push = useCallback(
    (
      kind: ToastKind,
      message: string,
      extra?: {
        code?: string;
        requestId?: string;
      },
    ) => {
      const id = nextId.current;
      nextId.current += 1;
      dispatch({
        type: 'push',
        toast: {
          id,
          kind,
          message,
          ...(extra?.code !== undefined ? { code: extra.code } : {}),
          ...(extra?.requestId !== undefined ? { requestId: extra.requestId } : {}),
        },
      });
      return id;
    },
    [],
  );
  // 自动消失：仅 info/success；error 常驻直至手动关闭
  useEffect(() => {
    if (durationMs <= 0) return;
    const timers = toasts
      .filter((toast) => toast.kind !== 'error')
      .map((toast) => setTimeout(() => dismiss(toast.id), durationMs));
    return () => timers.forEach(clearTimeout);
  }, [toasts, durationMs, dismiss]);
  return { toasts, push, dismiss };
}
