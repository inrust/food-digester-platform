/**
 * FE-02 Toast 队列（纯状态逻辑，便于无 DOM 测试）。
 * 错误 Toast 携带 CT-05 code/requestId，便于排障。
 */

export type ToastKind = 'info' | 'success' | 'error';

export interface ToastItem {
  readonly id: number;
  readonly kind: ToastKind;
  readonly message: string;
  readonly code?: string;
  readonly requestId?: string;
}

export type ToastAction = { type: 'push'; toast: ToastItem } | { type: 'dismiss'; id: number };

export function toastReducer(state: readonly ToastItem[], action: ToastAction): ToastItem[] {
  switch (action.type) {
    case 'push':
      return [...state, action.toast];
    case 'dismiss':
      return state.filter((toast) => toast.id !== action.id);
  }
}
