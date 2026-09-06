/**
 * FE-05 Site 管理页（/sites）：列表（customerId/region/subregion/status 筛选）+ 详情（含设备数）+ 创建/编辑/停用。
 *
 * - 写操作仅 canWrite（site:write：PlatformSuperAdmin/PlatformOperator）显示，后端仍强制 403；
 * - 创建/编辑表单客户端校验（名称必填、IANA 时区、邮箱格式），customerId 创建后不可变（编辑只读展示）；
 * - 停用弹窗展示关联设备数提示（有关联对象停用提示），原因必填；409 VERSION_CONFLICT → 提示刷新。
 */
import { useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { validateSiteInput } from './sites-state.js';
import type { SiteFieldErrors } from './sites-state.js';
import { SITE_STATUS_LABELS } from './types.js';
import type { SiteInput, SiteStatus, SiteView } from './types.js';

export interface SiteFilters {
  readonly customerId: string | null;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly status: SiteStatus | null;
}

export interface SitesPageProps {
  readonly list: {
    readonly rows: readonly SiteView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
    readonly nextCursor?: string | null;
  };
  readonly filters: SiteFilters;
  readonly onFilterChange: (filters: SiteFilters) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onRefresh: () => void;
  /** 客户选项（创建 Site 时选择所属客户；选项由 BE-CUS-01 注入）。 */
  readonly customerOptions: readonly { value: string; label: string }[];
  readonly canWrite: boolean;
  readonly onCreate: (customerId: string, input: SiteInput) => Promise<SiteView>;
  readonly onUpdate: (site: SiteView, input: SiteInput) => Promise<SiteView>;
  readonly onDeactivate: (site: SiteView, reason: string) => Promise<SiteView>;
}

type Dialog = { kind: 'create' } | { kind: 'edit'; site: SiteView } | { kind: 'deactivate'; site: SiteView };

const EMPTY_INPUT: SiteInput = {
  name: '',
  region: null,
  subregion: null,
  address: null,
  timezone: 'UTC',
  contactName: null,
  contactPhone: null,
  contactEmail: null,
};

function textOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function SiteFormDialog({
  dialog,
  customerOptions,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  readonly dialog: Extract<Dialog, { kind: 'create' | 'edit' }>;
  readonly customerOptions: SitesPageProps['customerOptions'];
  readonly busy: boolean;
  readonly error: unknown;
  readonly onSubmit: (customerId: string, input: SiteInput) => void;
  readonly onCancel: () => void;
}) {
  const editing = dialog.kind === 'edit' ? dialog.site : null;
  const [customerId, setCustomerId] = useState(editing?.customerId ?? '');
  const [form, setForm] = useState<SiteInput>(
    editing !== null
      ? {
          name: editing.name,
          region: editing.region,
          subregion: editing.subregion,
          address: editing.address,
          timezone: editing.timezone,
          contactName: editing.contactName,
          contactPhone: editing.contactPhone,
          contactEmail: editing.contactEmail,
        }
      : EMPTY_INPUT,
  );
  const [fieldErrors, setFieldErrors] = useState<SiteFieldErrors>({});

  const set = (patch: Partial<SiteInput>) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = () => {
    const errors = validateSiteInput(form);
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    if (editing === null && customerId === '') return;
    onSubmit(editing !== null ? editing.customerId : customerId, { ...form, name: form.name.trim() });
  };

  const field = (
    id: string,
    label: string,
    value: string,
    onChange: (v: string) => void,
    errorKey?: keyof SiteFieldErrors,
  ) => (
    <div className="dialog-field" key={id}>
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
      {errorKey !== undefined && fieldErrors[errorKey] !== undefined ? (
        <p role="alert" className="field-error" data-testid={`error-${errorKey}`}>
          {fieldErrors[errorKey]}
        </p>
      ) : null}
    </div>
  );

  return (
    <Modal open title={editing === null ? '新建站点' : '编辑站点'} onClose={onCancel} testid="site-form">
      {editing === null ? (
        <div className="dialog-field">
          <label htmlFor="site-customer">所属客户</label>
          <select id="site-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">请选择客户</option>
            {customerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="immutable-field" data-testid="site-customer-readonly">
          所属客户：{editing.customerId}（创建后不可变）
        </p>
      )}
      {field('site-name', '站点名称', form.name, (v) => set({ name: v }), 'name')}
      {field('site-region', '设备区域', form.region ?? '', (v) => set({ region: textOrNull(v) }))}
      {field('site-subregion', '设备子区域', form.subregion ?? '', (v) => set({ subregion: textOrNull(v) }))}
      {field('site-address', '地址', form.address ?? '', (v) => set({ address: textOrNull(v) }))}
      {field('site-timezone', '时区（IANA）', form.timezone, (v) => set({ timezone: v }), 'timezone')}
      {field('site-contact-name', '联系人', form.contactName ?? '', (v) => set({ contactName: textOrNull(v) }))}
      {field('site-contact-phone', '联系电话', form.contactPhone ?? '', (v) => set({ contactPhone: textOrNull(v) }))}
      {field(
        'site-contact-email',
        '联系邮箱',
        form.contactEmail ?? '',
        (v) => set({ contactEmail: textOrNull(v) }),
        'contactEmail',
      )}
      {error !== null && error !== undefined ? <ErrorNotice error={error} /> : null}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={submit}>
          保存
        </button>
      </div>
    </Modal>
  );
}

export function SitesPage({
  list,
  filters,
  onFilterChange,
  onLoadMore,
  onRefresh,
  customerOptions,
  canWrite,
  onCreate,
  onUpdate,
  onDeactivate,
}: SitesPageProps) {
  const [selected, setSelected] = useState<SiteView | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const runAction = async (fn: () => Promise<SiteView>) => {
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
    <div className="sites-page" data-testid="sites-page">
      <div className="page-toolbar">
        <div className="site-filters" data-testid="site-filters">
          <label htmlFor="filter-customer">所属客户</label>
          <select
            id="filter-customer"
            value={filters.customerId ?? ''}
            onChange={(e) => onFilterChange({ ...filters, customerId: e.target.value === '' ? null : e.target.value })}
          >
            <option value="">全部</option>
            {customerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label htmlFor="filter-region">设备区域</label>
          <input
            id="filter-region"
            value={filters.region ?? ''}
            onChange={(e) => onFilterChange({ ...filters, region: e.target.value === '' ? null : e.target.value })}
          />
          <label htmlFor="filter-subregion">设备子区域</label>
          <input
            id="filter-subregion"
            value={filters.subregion ?? ''}
            onChange={(e) => onFilterChange({ ...filters, subregion: e.target.value === '' ? null : e.target.value })}
          />
          <label htmlFor="filter-status">状态</label>
          <select
            id="filter-status"
            value={filters.status ?? ''}
            onChange={(e) =>
              onFilterChange({ ...filters, status: e.target.value === '' ? null : (e.target.value as SiteStatus) })
            }
          >
            <option value="">全部</option>
            <option value="ACTIVE">正常</option>
            <option value="SUSPENDED">已停用</option>
          </select>
        </div>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="create-site"
            onClick={() => setDialog({ kind: 'create' })}
          >
            新建站点
          </button>
        ) : null}
      </div>

      <CursorTable
        ariaLabel="站点列表"
        columns={[
          { key: 'name', header: '站点名称', render: (s) => s.name },
          { key: 'customerId', header: '所属客户', render: (s) => s.customerId },
          { key: 'region', header: '设备区域', render: (s) => s.region ?? '—' },
          { key: 'subregion', header: '设备子区域', render: (s) => s.subregion ?? '—' },
          { key: 'timezone', header: '时区', render: (s) => s.timezone },
          { key: 'contactName', header: '联系人', render: (s) => s.contactName ?? '—' },
          { key: 'deviceCount', header: '设备数', render: (s) => String(s.deviceCount) },
          { key: 'status', header: '状态', render: (s) => SITE_STATUS_LABELS[s.status] },
          {
            key: 'actions',
            header: '操作',
            render: (s) => (
              <button type="button" data-testid={`detail-${s.id}`} onClick={() => setSelected(s)}>
                详细信息
              </button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(s) => s.id}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        onNextPage={onLoadMore}
        onRefresh={onRefresh}
        emptyText="暂无站点"
      />

      {selected !== null ? (
        <aside className="detail-panel" data-testid="site-detail" aria-label="站点详情">
          <h4>站点详情</h4>
          <dl>
            <dt>站点ID</dt>
            <dd>{selected.id}</dd>
            <dt>所属客户</dt>
            <dd>{selected.customerId}</dd>
            <dt>站点名称</dt>
            <dd>{selected.name}</dd>
            <dt>设备区域 / 子区域</dt>
            <dd>
              {selected.region ?? '—'} / {selected.subregion ?? '—'}
            </dd>
            <dt>地址</dt>
            <dd>{selected.address ?? '—'}</dd>
            <dt>时区</dt>
            <dd>{selected.timezone}</dd>
            <dt>联系人</dt>
            <dd>
              {selected.contactName ?? '—'} / {selected.contactPhone ?? '—'} / {selected.contactEmail ?? '—'}
            </dd>
            <dt>设备数</dt>
            <dd data-testid="site-device-count">{selected.deviceCount}</dd>
            <dt>状态</dt>
            <dd data-testid="site-status">{SITE_STATUS_LABELS[selected.status]}</dd>
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
                  data-testid="edit-site"
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    setDialog({ kind: 'edit', site: selected });
                  }}
                >
                  编辑
                </button>
                {selected.status === 'ACTIVE' ? (
                  <button
                    type="button"
                    className="danger-button"
                    data-testid="deactivate-site"
                    disabled={busy}
                    onClick={() => {
                      setActionError(null);
                      setDialog({ kind: 'deactivate', site: selected });
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
        <SiteFormDialog
          dialog={dialog}
          customerOptions={customerOptions}
          busy={busy}
          error={actionError}
          onCancel={() => setDialog(null)}
          onSubmit={(customerId, input) => {
            if (dialog.kind === 'create') void runAction(() => onCreate(customerId, input));
            else void runAction(() => onUpdate(dialog.site, input));
          }}
        />
      ) : null}

      <ConfirmDialog
        open={dialog?.kind === 'deactivate'}
        title="停用站点"
        {...(dialog?.kind === 'deactivate'
          ? {
              description: `停用后站点「${dialog.site.name}」状态为已停用；该站点当前关联设备 ${dialog.site.deviceCount} 台（停用不影响设备归属）；原因将写入审计记录。`,
            }
          : {})}
        danger
        requireReason
        reasonLabel="停用原因"
        confirmText="确认停用"
        onConfirm={(reason) => {
          if (dialog?.kind === 'deactivate') void runAction(() => onDeactivate(dialog.site, reason));
        }}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
