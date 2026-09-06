/**
 * FE-05 Customer 管理页（/customers）：列表（状态筛选 + 游标分页）+ 详情 + 创建/改名/停用。
 *
 * - 写操作仅 canWrite（customer:write：PlatformSuperAdmin/PlatformOperator）显示，后端仍强制 403；
 * - 停用原因必填（写审计）；409 VERSION_CONFLICT → 提示刷新；409 CONFLICT（重复停用）→ 展示后端 message；
 * - 提交期间按钮禁用防重复。
 */
import { useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { CUSTOMER_STATUS_LABELS } from './types.js';
import type { CustomerStatus, CustomerView } from './types.js';

export interface CustomersPageProps {
  readonly list: {
    readonly rows: readonly CustomerView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
    readonly nextCursor?: string | null;
  };
  readonly statusFilter: CustomerStatus | null;
  readonly onFilterStatus: (status: CustomerStatus | null) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onRefresh: () => void;
  /** customer:write 持有者（PlatformSuperAdmin/PlatformOperator）。 */
  readonly canWrite: boolean;
  readonly onCreate: (input: { name: string }) => Promise<CustomerView>;
  readonly onUpdate: (customer: CustomerView, input: { name: string }) => Promise<CustomerView>;
  readonly onDeactivate: (customer: CustomerView, reason: string) => Promise<CustomerView>;
}

type Dialog =
  { kind: 'create' } | { kind: 'edit'; customer: CustomerView } | { kind: 'deactivate'; customer: CustomerView };

function CustomerFormDialog({
  dialog,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  readonly dialog: Extract<Dialog, { kind: 'create' | 'edit' }>;
  readonly busy: boolean;
  readonly error: unknown;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const editing = dialog.kind === 'edit' ? dialog.customer : null;
  const [name, setName] = useState(editing?.name ?? '');
  const invalid = name.trim().length === 0 || name.trim().length > 200;
  return (
    <Modal open title={editing === null ? '新建客户' : '编辑客户'} onClose={onCancel} testid="customer-form">
      <div className="dialog-field">
        <label htmlFor="customer-name">客户名称</label>
        <input id="customer-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </div>
      {error !== null && error !== undefined ? <ErrorNotice error={error} /> : null}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={invalid || busy}
          onClick={() => onSubmit(name.trim())}
        >
          保存
        </button>
      </div>
    </Modal>
  );
}

export function CustomersPage({
  list,
  statusFilter,
  onFilterStatus,
  onLoadMore,
  onRefresh,
  canWrite,
  onCreate,
  onUpdate,
  onDeactivate,
}: CustomersPageProps) {
  const [selected, setSelected] = useState<CustomerView | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const runAction = async (fn: () => Promise<CustomerView>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await fn();
      setDialog(null);
      setSelected(updated);
      onRefresh();
    } catch (err) {
      setActionError(err);
      // 停用确认框无错误展示区：失败即关闭，错误在详情面板显示
      setDialog((current) => (current?.kind === 'deactivate' ? null : current));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="customers-page" data-testid="customers-page">
      <div className="page-toolbar">
        <div className="status-tabs" role="tablist" aria-label="客户状态">
          {([null, 'ACTIVE', 'SUSPENDED'] as const).map((status) => (
            <button
              key={status ?? 'all'}
              type="button"
              role="tab"
              aria-selected={status === statusFilter}
              data-testid={`filter-${status ?? 'all'}`}
              onClick={() => onFilterStatus(status)}
            >
              {status === null ? '全部' : CUSTOMER_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="create-customer"
            onClick={() => setDialog({ kind: 'create' })}
          >
            新建客户
          </button>
        ) : null}
      </div>

      <CursorTable
        ariaLabel="客户列表"
        columns={[
          { key: 'name', header: '客户名称', render: (c) => c.name },
          { key: 'status', header: '状态', render: (c) => CUSTOMER_STATUS_LABELS[c.status] },
          { key: 'createdAt', header: '创建时间', render: (c) => <TimeText iso={c.createdAt} /> },
          { key: 'updatedAt', header: '更新时间', render: (c) => <TimeText iso={c.updatedAt} /> },
          {
            key: 'actions',
            header: '操作',
            render: (c) => (
              <button type="button" data-testid={`detail-${c.id}`} onClick={() => setSelected(c)}>
                详细信息
              </button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(c) => c.id}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        onNextPage={onLoadMore}
        onRefresh={onRefresh}
        emptyText="暂无客户"
      />

      {selected !== null ? (
        <aside className="detail-panel" data-testid="customer-detail" aria-label="客户详情">
          <h4>客户详情</h4>
          <dl>
            <dt>客户ID</dt>
            <dd>{selected.id}</dd>
            <dt>客户名称</dt>
            <dd>{selected.name}</dd>
            <dt>状态</dt>
            <dd data-testid="customer-status">{CUSTOMER_STATUS_LABELS[selected.status]}</dd>
            <dt>创建时间</dt>
            <dd>
              <TimeText iso={selected.createdAt} />
            </dd>
            <dt>更新时间</dt>
            <dd>
              <TimeText iso={selected.updatedAt} />
            </dd>
          </dl>
          {actionError !== null && dialog === null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}
          <div className="detail-actions">
            <button type="button" onClick={() => setSelected(null)}>
              关闭
            </button>
            {canWrite ? (
              <>
                <button
                  type="button"
                  data-testid="edit-customer"
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    setDialog({ kind: 'edit', customer: selected });
                  }}
                >
                  编辑
                </button>
                {selected.status === 'ACTIVE' ? (
                  <button
                    type="button"
                    className="danger-button"
                    data-testid="deactivate-customer"
                    disabled={busy}
                    onClick={() => {
                      setActionError(null);
                      setDialog({ kind: 'deactivate', customer: selected });
                    }}
                  >
                    停用
                  </button>
                ) : null}
              </>
            ) : null}
          </div>
        </aside>
      ) : null}

      {dialog !== null && dialog.kind !== 'deactivate' ? (
        <CustomerFormDialog
          dialog={dialog}
          busy={busy}
          error={actionError}
          onCancel={() => setDialog(null)}
          onSubmit={(name) => {
            if (dialog.kind === 'create') void runAction(() => onCreate({ name }));
            else void runAction(() => onUpdate(dialog.customer, { name }));
          }}
        />
      ) : null}

      <ConfirmDialog
        open={dialog?.kind === 'deactivate'}
        title="停用客户"
        {...(dialog?.kind === 'deactivate'
          ? { description: `停用后客户「${dialog.customer.name}」状态为已停用；原因将写入审计记录。` }
          : {})}
        danger
        requireReason
        reasonLabel="停用原因"
        confirmText="确认停用"
        onConfirm={(reason) => {
          if (dialog?.kind === 'deactivate') void runAction(() => onDeactivate(dialog.customer, reason));
        }}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
