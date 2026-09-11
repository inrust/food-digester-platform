/**
 * FE-02 游标表格：加载 / 空 / 错误（403/409/通用）/ 数据过期（stale）全状态覆盖。
 *
 * - rows=null 且非 loading/error → 尚未加载（显示加载态）；
 * - stale=true 时显示“数据可能过期”徽标与数据时间（TimeText）；
 * - 分页为 CT-05 游标式：下一页携 nextCursor；上一页由调用方维护游标栈。
 */
import type { ReactNode } from 'react';
import { ErrorNotice } from './ErrorNotice.js';
import { TimeText } from './TimeText.js';
import { useI18n } from '../i18n/i18n.js';

export interface CursorTableColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly render: (row: T) => ReactNode;
}

export interface CursorTableProps<T> {
  readonly columns: readonly CursorTableColumn<T>[];
  readonly rows: readonly T[] | null;
  readonly rowKey: (row: T) => string;
  readonly loading?: boolean;
  readonly error?: unknown;
  /** 数据已过期（如筛选变更后未刷新）。 */
  readonly stale?: boolean;
  /** 数据产生时间（UTC ISO），stale 或常规展示用。 */
  readonly dataUpdatedAt?: string;
  readonly nextCursor?: string | null;
  readonly hasPrevPage?: boolean;
  readonly onNextPage?: (cursor: string) => void;
  readonly onPrevPage?: () => void;
  readonly onRefresh?: () => void;
  readonly emptyText?: string;
  readonly ariaLabel: string;
  /** 行级 className（如 CRITICAL 告警显著行）。 */
  readonly rowClassName?: (row: T) => string | undefined;
}

export function CursorTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  error,
  stale = false,
  dataUpdatedAt,
  nextCursor = null,
  hasPrevPage = false,
  onNextPage,
  onPrevPage,
  onRefresh,
  emptyText,
  ariaLabel,
  rowClassName,
}: CursorTableProps<T>) {
  const { t } = useI18n();
  const resolvedEmptyText = emptyText ?? t('common.empty');
  if (error !== undefined && error !== null) {
    return <ErrorNotice error={error} {...(onRefresh !== undefined ? { onRefresh } : {})} />;
  }

  if (rows === null) {
    return (
      <div role="status" data-testid="table-loading">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="cursor-table" data-testid="cursor-table">
      {stale || loading ? (
        <div className="stale-banner" role="status" data-testid="table-stale">
          {t('common.stale')}
          {dataUpdatedAt !== undefined ? (
            <>
              （{t('common.dataTime')}
              <TimeText iso={dataUpdatedAt} />）
            </>
          ) : null}
          {onRefresh !== undefined ? (
            <button type="button" onClick={onRefresh}>
              {t('common.refresh')}
            </button>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="empty-state" data-testid="table-empty">
          {resolvedEmptyText}
        </div>
      ) : (
        <table aria-label={ariaLabel}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.key} scope="col">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const extraClass = rowClassName?.(row);
              return (
                <tr key={rowKey(row)} {...(extraClass !== undefined ? { className: extraClass } : {})}>
                  {columns.map((column) => (
                    <td key={column.key}>{column.render(row)}</td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="table-pagination">
        <button type="button" disabled={!hasPrevPage} onClick={onPrevPage}>
          {t('common.prevPage')}
        </button>
        <button
          type="button"
          disabled={nextCursor === null}
          onClick={() => {
            if (nextCursor !== null) onNextPage?.(nextCursor);
          }}
        >
          {t('common.nextPage')}
        </button>
      </div>
    </div>
  );
}
