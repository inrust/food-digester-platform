import { translate } from '../../i18n/i18n.js';
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
import { NumberText } from '../../components/LocaleValue.js';
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
    readonly stale?: boolean;
    readonly dataUpdatedAt?: string;
    readonly hasPrevPage?: boolean;
  };
  readonly filters: SiteFilters;
  readonly onFilterChange: (filters: SiteFilters) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly onLoadPrevious?: () => void;
  readonly onRefresh: () => void;
  /** 客户选项（创建 Site 时选择所属客户；选项由 BE-CUS-01 注入）。 */
  readonly customerOptions: readonly {
    value: string;
    label: string;
  }[];
  readonly canWrite: boolean;
  readonly onCreate: (customerId: string, input: SiteInput) => Promise<SiteView>;
  readonly onUpdate: (site: SiteView, input: SiteInput) => Promise<SiteView>;
  readonly onDeactivate: (site: SiteView, reason: string) => Promise<SiteView>;
}
type Dialog =
  | {
      kind: 'create';
    }
  | {
      kind: 'edit';
      site: SiteView;
    }
  | {
      kind: 'deactivate';
      site: SiteView;
    };
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
  readonly dialog: Extract<
    Dialog,
    {
      kind: 'create' | 'edit';
    }
  >;
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
    <Modal
      open
      title={editing === null ? translate('page.97cf62968aef') : translate('page.8ccf593f7e72')}
      onClose={onCancel}
      testid="site-form"
    >
      {editing === null ? (
        <div className="dialog-field">
          <label htmlFor="site-customer">{translate('page.467c1137f479')}</label>
          <select id="site-customer" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">{translate('page.6bdb05d6eeeb')}</option>
            {customerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <p className="immutable-field" data-testid="site-customer-readonly">
          {translate('page.fc18f5657efc')}
          {editing.customerId}
          {translate('page.73108099a058')}
        </p>
      )}
      {field('site-name', translate('page.e72ec84bc978'), form.name, (v) => set({ name: v }), 'name')}
      {field('site-region', translate('page.406e0f8c6852'), form.region ?? '', (v) => set({ region: textOrNull(v) }))}
      {field('site-subregion', translate('page.ff0beacd69e2'), form.subregion ?? '', (v) =>
        set({ subregion: textOrNull(v) }),
      )}
      {field('site-address', translate('page.67d2d7970f4a'), form.address ?? '', (v) =>
        set({ address: textOrNull(v) }),
      )}
      {field('site-timezone', translate('page.21a8c183a3fa'), form.timezone, (v) => set({ timezone: v }), 'timezone')}
      {field('site-contact-name', translate('page.2425bd4bc11b'), form.contactName ?? '', (v) =>
        set({ contactName: textOrNull(v) }),
      )}
      {field('site-contact-phone', translate('page.e02f6e5760fd'), form.contactPhone ?? '', (v) =>
        set({ contactPhone: textOrNull(v) }),
      )}
      {field(
        'site-contact-email',
        translate('page.f0b45bf78e76'),
        form.contactEmail ?? '',
        (v) => set({ contactEmail: textOrNull(v) }),
        'contactEmail',
      )}
      {error !== null && error !== undefined ? <ErrorNotice error={error} /> : null}
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          {translate('page.4d0b4688c787')}
        </button>
        <button type="button" className="primary-button" disabled={busy} onClick={submit}>
          {translate('page.fadf24dbc5a9')}
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
  onLoadPrevious,
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
          <label htmlFor="filter-customer">{translate('page.467c1137f479')}</label>
          <select
            id="filter-customer"
            value={filters.customerId ?? ''}
            onChange={(e) => onFilterChange({ ...filters, customerId: e.target.value === '' ? null : e.target.value })}
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            {customerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <label htmlFor="filter-region">{translate('page.406e0f8c6852')}</label>
          <input
            id="filter-region"
            value={filters.region ?? ''}
            onChange={(e) => onFilterChange({ ...filters, region: e.target.value === '' ? null : e.target.value })}
          />
          <label htmlFor="filter-subregion">{translate('page.ff0beacd69e2')}</label>
          <input
            id="filter-subregion"
            value={filters.subregion ?? ''}
            onChange={(e) => onFilterChange({ ...filters, subregion: e.target.value === '' ? null : e.target.value })}
          />
          <label htmlFor="filter-status">{translate('page.62e951a692ff')}</label>
          <select
            id="filter-status"
            value={filters.status ?? ''}
            onChange={(e) =>
              onFilterChange({ ...filters, status: e.target.value === '' ? null : (e.target.value as SiteStatus) })
            }
          >
            <option value="">{translate('page.778fc8f99453')}</option>
            <option value="ACTIVE">{translate('page.f78d037abccd')}</option>
            <option value="SUSPENDED">{translate('page.6c7dcbb73a59')}</option>
          </select>
        </div>
        {canWrite ? (
          <button
            type="button"
            className="primary-button"
            data-testid="create-site"
            onClick={() => setDialog({ kind: 'create' })}
          >
            {translate('page.97cf62968aef')}
          </button>
        ) : null}
      </div>

      <CursorTable
        ariaLabel={translate('page.0bfb6aec5482')}
        columns={[
          { key: 'name', header: translate('page.e72ec84bc978'), render: (s) => s.name },
          { key: 'customerId', header: translate('page.467c1137f479'), render: (s) => s.customerId },
          { key: 'region', header: translate('page.406e0f8c6852'), render: (s) => s.region ?? '—' },
          { key: 'subregion', header: translate('page.ff0beacd69e2'), render: (s) => s.subregion ?? '—' },
          { key: 'timezone', header: translate('page.fb2a23dc1601'), render: (s) => s.timezone },
          { key: 'contactName', header: translate('page.2425bd4bc11b'), render: (s) => s.contactName ?? '—' },
          {
            key: 'deviceCount',
            header: translate('page.7beb4b6b2974'),
            render: (s) => <NumberText value={s.deviceCount} />,
          },
          { key: 'status', header: translate('page.62e951a692ff'), render: (s) => SITE_STATUS_LABELS[s.status] },
          {
            key: 'actions',
            header: translate('page.f3ea6d345e2a'),
            render: (s) => (
              <button type="button" data-testid={`detail-${s.id}`} onClick={() => setSelected(s)}>
                {translate('page.b6e664d7362f')}
              </button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(s) => s.id}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        {...(list.stale !== undefined ? { stale: list.stale } : {})}
        {...(list.dataUpdatedAt !== undefined ? { dataUpdatedAt: list.dataUpdatedAt } : {})}
        {...(list.hasPrevPage !== undefined ? { hasPrevPage: list.hasPrevPage } : {})}
        onNextPage={onLoadMore}
        {...(onLoadPrevious !== undefined ? { onPrevPage: onLoadPrevious } : {})}
        onRefresh={onRefresh}
        emptyText={translate('page.5e494547b40c')}
      />

      {selected !== null ? (
        <aside className="detail-panel" data-testid="site-detail" aria-label={translate('page.78e70b8d9e4e')}>
          <h4>{translate('page.78e70b8d9e4e')}</h4>
          <dl>
            <dt>{translate('page.194f9bfdf96d')}</dt>
            <dd>{selected.id}</dd>
            <dt>{translate('page.467c1137f479')}</dt>
            <dd>{selected.customerId}</dd>
            <dt>{translate('page.e72ec84bc978')}</dt>
            <dd>{selected.name}</dd>
            <dt>{translate('page.a7a1979e6c82')}</dt>
            <dd>
              {selected.region ?? '—'} / {selected.subregion ?? '—'}
            </dd>
            <dt>{translate('page.67d2d7970f4a')}</dt>
            <dd>{selected.address ?? '—'}</dd>
            <dt>{translate('page.fb2a23dc1601')}</dt>
            <dd>{selected.timezone}</dd>
            <dt>{translate('page.2425bd4bc11b')}</dt>
            <dd>
              {selected.contactName ?? '—'} / {selected.contactPhone ?? '—'} / {selected.contactEmail ?? '—'}
            </dd>
            <dt>{translate('page.7beb4b6b2974')}</dt>
            <dd data-testid="site-device-count">
              <NumberText value={selected.deviceCount} />
            </dd>
            <dt>{translate('page.62e951a692ff')}</dt>
            <dd data-testid="site-status">{SITE_STATUS_LABELS[selected.status]}</dd>
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
                  data-testid="edit-site"
                  disabled={busy}
                  onClick={() => {
                    setActionError(null);
                    setDialog({ kind: 'edit', site: selected });
                  }}
                >
                  {translate('page.a7f814c0a40d')}
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
                    {translate('page.d989e55188c9')}
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
        title={translate('page.a10b67b937d5')}
        {...(dialog?.kind === 'deactivate'
          ? {
              description:
                translate('page.e99b02d3ce06') +
                dialog.site.name +
                (translate('page.6d5b3a80ea3a') + ' ') +
                dialog.site.deviceCount +
                (' ' + translate('page.611bc78bd302')),
            }
          : {})}
        danger
        requireReason
        reasonLabel={translate('page.d599ea3c90af')}
        confirmText={translate('page.f3abd8941903')}
        onConfirm={(reason) => {
          if (dialog?.kind === 'deactivate') void runAction(() => onDeactivate(dialog.site, reason));
        }}
        onCancel={() => setDialog(null)}
      />
    </div>
  );
}
