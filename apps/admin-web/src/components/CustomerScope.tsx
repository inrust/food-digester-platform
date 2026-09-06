/**
 * FE-02 Customer scope 组件：
 * - Customer 角色：只读展示所属 Customer（scope 由 FE-01 会话注入，不可切换）；
 * - 平台角色：选择器（选项由 API 注入，null = 全部客户）。
 */
import type { FilterOption } from './ScopeFilter.js';

export interface CustomerScopeProps {
  readonly mode: 'fixed' | 'select';
  /** fixed 模式下展示的所属客户名。 */
  readonly fixedLabel?: string;
  readonly options?: readonly FilterOption[];
  readonly value?: string | null;
  readonly onChange?: (customerId: string | null) => void;
}

export function CustomerScope({ mode, fixedLabel, options = [], value = null, onChange }: CustomerScopeProps) {
  if (mode === 'fixed') {
    return (
      <span className="customer-scope" data-testid="customer-scope-fixed">
        所属客户：{fixedLabel ?? '—'}
      </span>
    );
  }
  return (
    <div className="customer-scope" data-testid="customer-scope-select">
      <label htmlFor="customer-scope-select">客户范围</label>
      <select
        id="customer-scope-select"
        value={value ?? ''}
        onChange={(event) => onChange?.(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">全部客户</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}
