import { translate } from '../../i18n/i18n.js';
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
    readonly stale?: boolean;
    readonly dataUpdatedAt?: string;
    readonly hasPrevPage?: boolean;
  };
  readonly statusFilter: CustomerStatus | null;
  readonly onFilterStatus: (status: CustomerStatus | null) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onLoadPrevious?: () => void;
  readonly onRefresh: () => void;
  /** customer:write 持有者（PlatformSuperAdmin/PlatformOperator）。 */
  readonly canWrite: boolean;
  readonly onCreate: (input: { name: string }) => Promise<CustomerView>;
  readonly onUpdate: (
    customer: CustomerView,
    input: {
      name: string;
    },
  ) => Promise<CustomerView>;
  readonly onDeactivate: (customer: CustomerView, reason: string) => Promise<CustomerView>;
}
type Dialog =
  | {
      kind: 'create';
    }
  | {
      kind: 'edit';
      customer: CustomerView;
    }
  | {
      kind: 'deactivate';
      customer: CustomerView;
    };
function CustomerFormDialog({
  dialog,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  readonly dialog: Extract<
    Dialog,
    {
      kind: 'create' | 'edit';
    }
  >;
  readonly busy: boolean;
  readonly error: unknown;
  readonly onSubmit: (name: string) => void;
  readonly onCancel: () => void;
}) {
  const editing = dialog.kind === 'edit' ? dialog.customer : null;
  const [name, setName] = useState(editing?.name ?? '');
  const invalid = name.trim().length === 0 || name.trim().length > 200;
  return (
    <Modal
      open
      title={editing === null ? translate('page.623d4cb5b1d7') : translate('page.77a9dae90d43')}
      onClose={onCancel}
      testid="customer-form"
    >
      <div className="dialog-field">
        <label htmlFor="customer-name">{translate('page.e941d410f4c9')}</label>
        <input id="customer-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </div>
      {error !== null && error !== undefined ? <ErrorNotice error={error} /> : null}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {translate('page.4d0b4688c787')}
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={invalid || busy}
          onClick={() => onSubmit(name.trim())}
        >
          {translate('page.fadf24dbc5a9')}
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
  onLoadPrevious,
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
        <div className="status-tabs" role="tablist" aria-label={translate('page.d6ca3e50f98e')}>
          {([null, 'ACTIVE', 'SUSPENDED'] as const).map((status) => (
            <button
              key={status ?? 'all'}
              type="button"
              role="tab"
              aria-selected={status === statusFilter}
              data-testid={`filter-${status ?? 'all'}`}
              onClick={() => onFilterStatus(status)}
            >
              {status === null ? translate('page.778fc8f99453') : CUSTOMER_STATUS_LABELS[status]}
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
            {translate('page.623d4cb5b1d7')}
          </button>
        ) : null}
      </div>

      <CursorTable
        ariaLabel={translate('page.a630e0099f6a')}
        columns={[
          { key: 'name', header: translate('page.e941d410f4c9'), render: (c) => c.name },
          { key: 'status', header: translate('page.62e951a692ff'), render: (c) => CUSTOMER_STATUS_LABELS[c.status] },
          { key: 'createdAt', header: translate('page.84e3802f60a7'), render: (c) => <TimeText iso={c.createdAt} /> },
          { key: 'updatedAt', header: translate('page.093dea88c930'), render: (c) => <TimeText iso={c.updatedAt} /> },
          {
            key: 'actions',
            header: translate('page.f3ea6d345e2a'),
            render: (c) => (
              <button type="button" data-testid={`detail-${c.id}`} onClick={() => setSelected(c)}>
                {translate('page.b6e664d7362f')}
              </button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(c) => c.id}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        {...(list.stale !== undefined ? { stale: list.stale } : {})}
        {...(list.dataUpdatedAt !== undefined ? { dataUpdatedAt: list.dataUpdatedAt } : {})}
        {...(list.hasPrevPage !== undefined ? { hasPrevPage: list.hasPrevPage } : {})}
        onNextPage={onLoadMore}
        {...(onLoadPrevious !== undefined ? { onPrevPage: onLoadPrevious } : {})}
        onRefresh={onRefresh}
        emptyText={translate('page.9421c7837592')}
      />

      {selected !== null ? (
        <aside className="detail-panel" data-testid="customer-detail" aria-label={translate('page.ccd01125a13d')}>
          <h4>{translate('page.ccd01125a13d')}</h4>
          <dl>
            <dt>{translate('page.86df7fa3d818')}</dt>
            <dd>{selected.id}</dd>
            <dt>{translate('page.e941d410f4c9')}</dt>
            <dd>{selected.name}</dd>
            <dt>{translate('page.62e951a692ff')}</dt>
            <dd data-testid="customer-status">{CUSTOMER_STATUS_LABELS[selected.status]}</dd>
            <dt>{translate('page.84e3802f60a7')}</dt>
            <dd>
              <TimeText iso={selected.createdAt} />
            </dd>
            <dt>{translate('page.093dea88c930')}</dt>
            <dd>
              <TimeText iso={selected.updatedAt} />
            </dd>
          </dl>
          {actionError !== null && dialog === null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}
          <div className="detail-actions">
            <button type="button" onClick={() => setSelected(null)}>
              {translate('page.6c14bd7f6f9e')}
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
                  {translate('page.a7f814c0a40d')}
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
                    {translate('page.d989e55188c9')}
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
        title={translate('page.58ce3d697b9e')}
        {...(dialog?.kind === 'deactivate'
          ? { description: translate('page.4a148426207f') + dialog.customer.name + translate('page.ba8468923fe0') }
          : {})}
        danger
        requireReason
        reasonLabel={translate('page.d599ea3c90af')}
        confirmText={translate('page.f3abd8941903')}
        onConfirm={(reason) => {
          if (dialog?.kind === 'deactivate') void runAction(() => onDeactivate(dialog.customer, reason));
        }}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
