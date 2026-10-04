import { Button } from './ui.js';
/**
 * FE-02 游标表格：加载 / 空 / 错误（403/409/通用）/ 数据过期（stale）全状态覆盖。
 *
 * - rows=null 且非 loading/error → 尚未加载（显示加载态）；
 * - stale=true 时显示“数据可能过期”徽标与数据时间（TimeText）；
 * - 分页为 CT-05 游标式：下一页携 nextCursor；上一页由调用方维护游标栈。
 */
import { Empty, Skeleton, Table } from 'antd';
import { useMemo } from 'react';
import type { HTMLAttributes, ReactNode } from 'react';
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
  const tableComponents = useMemo(
    () => ({ table: (props: HTMLAttributes<HTMLTableElement>) => <table {...props} aria-label={ariaLabel} /> }),
    [ariaLabel],
  );
  const resolvedEmptyText = emptyText ?? t('common.empty');
  if (error !== undefined && error !== null) {
    return <ErrorNotice error={error} {...(onRefresh !== undefined ? { onRefresh } : {})} />;
  }

  if (rows === null) {
    return (
      <div className="table-loading" role="status" data-testid="table-loading">
        {t('common.loading')}
        <Skeleton active title={false} paragraph={{ rows: 4 }} />
      </div>
    );
  }

  return (
    <div className="cursor-table" data-testid="cursor-table" aria-busy={loading}>
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
            <Button type="button" onClick={onRefresh}>
              {t('common.refresh')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="empty-state" data-testid="table-empty">
          <Empty
            image={
              <svg aria-hidden="true" width="48" height="40" viewBox="0 0 48 40" fill="none">
                <path d="M8 15h32v20H8z M16 15V5h16v10 M18 24h12" stroke="#a8b8c5" strokeWidth="2" />
              </svg>
            }
            description={resolvedEmptyText}
            styles={{ image: { fontSize: 0 } }}
          />
        </div>
      ) : (
        <div className="table-scroll">
          <Table
            components={tableComponents}
            size="middle"
            pagination={false}
            dataSource={rows.map((row) => ({ key: rowKey(row), source: row }))}
            columns={columns.map((column) => ({
              key: column.key,
              title: column.header,
              render: (_: unknown, record: { source: T }) => column.render(record.source),
            }))}
            rowClassName={(record) => rowClassName?.(record.source) ?? ''}
          />
        </div>
      )}

      <div className="table-pagination">
        <Button type="button" disabled={!hasPrevPage} onClick={onPrevPage}>
          {t('common.prevPage')}
        </Button>
        <Button
          type="button"
          disabled={nextCursor === null}
          onClick={() => {
            if (nextCursor !== null) onNextPage?.(nextCursor);
          }}
        >
          {t('common.nextPage')}
        </Button>
      </div>
    </div>
  );
}
