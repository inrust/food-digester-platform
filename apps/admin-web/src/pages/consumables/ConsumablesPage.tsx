import { FilterBar } from '../../components/FilterBar.js';
import { Button, Input, TextArea } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
/**
 * FE-18 耗材状态与更换申请页（/consumables）：耗材列表 + 更换申请两区域。
 *
 * - 耗材列表：Region/Subregion/Site、连接状态、关键字（ID/序列号/别名）、阈值筛选；
 *   显示标准耗材名称、百分比（unknown 仅文本不画进度条）、observedAt/stale 徽标；
 *   阈值颜色（<10%/10~30%/>30%）为暂定展示阈值，由 prop（字典/配置）驱动；
 * - 联系方式：列表不含 PII，点击后调用独立授权端点按需加载；
 * - 更换申请：PENDING→PROCESSING→COMPLETED/CANCELLED，操作携带 version + 备注
 *   （complete/cancel 强制）；重复创建幂等（replayed 提示）；跳级由矩阵禁用 + 服务端 409；
 * - 边界：不预测寿命、不直接联系、不做库存/派单；协议冻结前无“来自设备”入口（source=ADMIN）。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { ApiClientError } from '../../api/errors.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { PercentText } from '../../components/LocaleValue.js';
import { Modal } from '../../components/Modal.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import { TimeText } from '../../components/TimeText.js';
import type { ConsumableRequestFilter, ConsumableStatusFilter } from './consumables-api.js';
import {
  CONSUMABLE_TYPES,
  CONSUMABLE_TYPE_LABELS,
  REQUEST_ACTION_LABELS,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_OPTIONS,
  canWriteDevices,
  gateRequestAction,
  thresholdLevel,
  validateRequestNote,
} from './consumable-state.js';
import type { ConsumableThresholdSource, ConsumableThresholds, RequestAction } from './consumable-state.js';
import type {
  ConsumableContactView,
  ConsumableRequestCreateResult,
  ConsumableRequestNoteStage,
  ConsumableRequestStatus,
  ConsumableRequestView,
  ConsumableStatusView,
  ConsumableType,
  ConsumableValueView,
} from './types.js';
export interface ConsumablesPageProps {
  readonly role: Role;
  readonly status: {
    readonly rows: readonly ConsumableStatusView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
    readonly nextCursor?: string | null;
    readonly hasPrevPage?: boolean;
  };
  readonly statusFilter: ConsumableStatusFilter;
  readonly onApplyStatusFilter: (filter: ConsumableStatusFilter) => void;
  readonly onNextStatusPage: (cursor: string) => void;
  readonly onPrevStatusPage: () => void;
  readonly onLoadContact: (deviceId: string) => Promise<ConsumableContactView>;
  readonly requests: {
    readonly rows: readonly ConsumableRequestView[] | null;
    readonly error?: unknown;
  };
  readonly requestFilter: ConsumableRequestFilter;
  readonly onApplyRequestFilter: (filter: ConsumableRequestFilter) => void;
  readonly onLoadRequestDevices: () => Promise<readonly FilterOption[]>;
  readonly onCreateRequest: (
    deviceId: string,
    consumableType: ConsumableType,
    note?: string,
  ) => Promise<ConsumableRequestCreateResult>;
  readonly onProcess: (requestId: string, note: string | null, version: number) => Promise<ConsumableRequestView>;
  readonly onComplete: (requestId: string, note: string, version: number) => Promise<ConsumableRequestView>;
  readonly onCancel: (requestId: string, note: string, version: number) => Promise<ConsumableRequestView>;
  readonly onRefresh: () => void;
  readonly thresholds: ConsumableThresholds;
  readonly thresholdSource: ConsumableThresholdSource;
}
type ActionTarget = {
  readonly action: RequestAction;
  readonly request: ConsumableRequestView;
};
const REQUEST_NOTE_STAGES = [
  'request',
  'processing',
  'completion',
  'cancellation',
] as const satisfies readonly ConsumableRequestNoteStage[];
const REQUEST_NOTE_LABELS = {
  request: 'consumables.requestNote',
  processing: 'consumables.processingNote',
  completion: 'consumables.completionNote',
  cancellation: 'consumables.cancellationNote',
} as const satisfies Record<ConsumableRequestNoteStage, string>;
const REQUEST_ACTION_COPY = {
  process: {
    description: 'consumables.processDescription',
    noteLabel: 'consumables.processOptional',
    success: 'consumables.processSuccess',
  },
  complete: {
    description: 'consumables.completeDescription',
    noteLabel: 'consumables.completeRequired',
    success: 'consumables.completeSuccess',
  },
  cancel: {
    description: 'consumables.cancelDescription',
    noteLabel: 'consumables.cancelRequired',
    success: 'consumables.cancelSuccess',
  },
} as const;

function RequestNotes({ request }: { readonly request: ConsumableRequestView }) {
  const stages = REQUEST_NOTE_STAGES.flatMap((stage) => {
    const entry = request.stageNotes?.[stage];
    return entry === undefined ? [] : [{ stage, ...entry }];
  });
  const legacy =
    request.stageNotes?.legacy ??
    (request.stageNotes === undefined && request.processNote !== null ? [request.processNote] : []);
  if (stages.length === 0 && legacy.length === 0) return '—';
  return (
    <dl className="consumable-request-notes" data-testid={`consumable-request-notes-${request.requestId}`}>
      {stages.map(({ stage, note, source }) => (
        <div key={stage}>
          <dt>
            {translate(REQUEST_NOTE_LABELS[stage])}
            {source === 'AUDIT' ? ` (${translate('consumables.auditRecovered')})` : ''}
          </dt>
          <dd>{note}</dd>
        </div>
      ))}
      {legacy.length > 0 ? (
        <div>
          <dt>{translate('consumables.legacyNote')}</dt>
          {legacy.map((note) => (
            <dd key={note}>{note}</dd>
          ))}
        </div>
      ) : null}
    </dl>
  );
}

type RequestDeviceOptions =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly options: readonly FilterOption[] }
  | { readonly kind: 'error'; readonly error: unknown };
const EMPTY_CREATE_DRAFT = { deviceId: '', consumableType: '' as ConsumableType | '', note: '' };
const EMPTY_STATUS_DRAFT: StatusDraft = {
  region: '',
  subregion: '',
  siteId: '',
  connectivity: '',
  keyword: '',
  maxRemainingPercent: '',
  consumableType: '',
  customerId: '',
};
interface StatusDraft {
  readonly region: string;
  readonly subregion: string;
  readonly siteId: string;
  readonly connectivity: 'ONLINE' | 'OFFLINE' | '';
  readonly keyword: string;
  readonly maxRemainingPercent: string;
  readonly consumableType: ConsumableType | '';
  readonly customerId: string;
}
function ConsumableCell({
  value,
  testid,
  thresholds,
}: {
  readonly value: ConsumableValueView | null;
  readonly testid: string;
  readonly thresholds: ConsumableThresholds;
}) {
  if (value === null || value.remainingPercent === null || value.remainingDisplay === 'unknown') {
    return (
      <span data-testid={testid}>
        {translate('page.6f3e8d799474')}
        {value?.stale === true ? <span className="stale-badge">{translate('page.e7ebfebaaa0f')}</span> : null}
      </span>
    );
  }
  const level = thresholdLevel(value.remainingPercent, thresholds);
  return (
    <span data-testid={testid}>
      <span className="consumable-bar" data-level={level ?? 'ok'} style={{ width: `${value.remainingPercent}%` }} />
      <PercentText value={value.remainingPercent} />
      {value.stale ? <span className="stale-badge">{translate('page.e7ebfebaaa0f')}</span> : null}
      {value.observedAt !== null ? (
        <span className="field-hint">
          （<TimeText iso={value.observedAt} />）
        </span>
      ) : null}
    </span>
  );
}
export function ConsumablesPage({
  role,
  status,
  statusFilter,
  onApplyStatusFilter,
  onNextStatusPage,
  onPrevStatusPage,
  onLoadContact,
  requests,
  requestFilter,
  onApplyRequestFilter,
  onLoadRequestDevices,
  onCreateRequest,
  onProcess,
  onComplete,
  onCancel,
  onRefresh,
  thresholds,
  thresholdSource,
}: ConsumablesPageProps) {
  const [statusDraft, setStatusDraft] = useState<StatusDraft>({
    ...EMPTY_STATUS_DRAFT,
    region: statusFilter.region ?? '',
    subregion: statusFilter.subregion ?? '',
    siteId: statusFilter.siteId ?? '',
    connectivity: statusFilter.connectivity ?? '',
    keyword: statusFilter.keyword ?? '',
    customerId: statusFilter.customerId ?? '',
  });
  const [requestDraft, setRequestDraft] = useState<{
    status: ConsumableRequestStatus | '';
    consumableType: ConsumableType | '';
    deviceId: string;
    customerId: string;
  }>({
    status: requestFilter.status ?? '',
    consumableType: requestFilter.consumableType ?? '',
    deviceId: requestFilter.deviceId ?? '',
    customerId: requestFilter.customerId ?? '',
  });
  const [contacts, setContacts] = useState<
    Readonly<
      Record<
        string,
        | { readonly kind: 'loading' }
        | { readonly kind: 'ready'; readonly value: ConsumableContactView }
        | { readonly kind: 'error'; readonly error: unknown }
      >
    >
  >({});
  const [action, setAction] = useState<ActionTarget | null>(null);
  const [actionNote, setActionNote] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createDraft, setCreateDraft] = useState(EMPTY_CREATE_DRAFT);
  const [deviceOptions, setDeviceOptions] = useState<RequestDeviceOptions>({ kind: 'loading' });
  const [deviceSearch, setDeviceSearch] = useState('');
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<unknown>(null);
  const deviceLoad = useRef(0);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const isPlatformRole = !role.startsWith('Customer');
  const canWrite = canWriteDevices(role);
  const deviceEligible =
    deviceOptions.kind === 'ready' && deviceOptions.options.some((option) => option.value === createDraft.deviceId);
  const search = deviceSearch.trim().toLowerCase();
  const visibleDevices =
    deviceOptions.kind === 'ready'
      ? deviceOptions.options.filter(
          (option) => option.value === createDraft.deviceId || option.label.toLowerCase().includes(search),
        )
      : [];
  const loadRequestDevices = async () => {
    const generation = ++deviceLoad.current;
    setDeviceOptions({ kind: 'loading' });
    setDeviceError(null);
    setCreateDraft((draft) => ({ ...draft, deviceId: '' }));
    try {
      const options = await onLoadRequestDevices();
      if (deviceLoad.current === generation) setDeviceOptions({ kind: 'ready', options });
    } catch (error) {
      if (deviceLoad.current === generation) setDeviceOptions({ kind: 'error', error });
    }
  };
  const closeCreate = () => {
    deviceLoad.current += 1;
    setCreateOpen(false);
  };
  const actionCopy = action === null ? null : REQUEST_ACTION_COPY[action.action];
  const noteRequired = action !== null && action.action !== 'process';
  const noteError = action !== null ? validateRequestNote(actionNote, noteRequired) : null;
  const conflictCode = actionError instanceof ApiClientError ? actionError.code : null;
  const refreshAfterConflict = () => {
    setAction(null);
    setActionError(null);
    onRefresh();
  };
  const loadContact = async (deviceId: string) => {
    setContacts((current) => ({ ...current, [deviceId]: { kind: 'loading' } }));
    try {
      const value = await onLoadContact(deviceId);
      setContacts((current) => ({ ...current, [deviceId]: { kind: 'ready', value } }));
    } catch (error) {
      setContacts((current) => ({ ...current, [deviceId]: { kind: 'error', error } }));
    }
  };
  const runAction = async (execute: () => Promise<string>, onError: (error: unknown) => void = setActionError) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      setNotice(await execute());
      setAction(null);
      closeCreate();
      onRefresh();
    } catch (err) {
      onError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const submitAction = () => {
    if (action === null || actionCopy === null || noteError !== null) return;
    return runAction(async () => {
      const note = actionNote.trim();
      const { requestId, version } = action.request;
      if (action.action === 'process') await onProcess(requestId, note === '' ? null : note, version);
      if (action.action === 'complete') await onComplete(requestId, note, version);
      if (action.action === 'cancel') await onCancel(requestId, note, version);
      return translate(actionCopy.success, { id: requestId });
    });
  };
  const submitCreate = () => {
    const { deviceId, consumableType, note } = createDraft;
    if (!canWrite || !deviceEligible || consumableType === '') return;
    const generation = deviceLoad.current;
    setCreateError(null);
    void runAction(
      async () => {
        const result = await onCreateRequest(deviceId, consumableType, note.trim() === '' ? undefined : note.trim());
        return result.replayed
          ? translate('page.46c2995a52f6')
          : translate('page.2070de48878e') + result.request.requestId + '\uFF09';
      },
      (error) => {
        if (generation !== deviceLoad.current) {
          setActionError(error);
          return;
        }
        if (
          error instanceof ApiClientError &&
          (error.status === 404 || error.status === 403 || error.code === 'CONFLICT')
        ) {
          setCreateDraft((draft) => ({ ...draft, deviceId: '' }));
          setDeviceOptions((current) =>
            current.kind === 'ready'
              ? { kind: 'ready', options: current.options.filter((option) => option.value !== deviceId) }
              : current,
          );
          setDeviceError(
            translate(error.status === 403 ? 'consumables.deviceForbidden' : 'consumables.deviceUnavailable'),
          );
        } else setCreateError(error);
      },
    );
  };
  return (
    <div className="consumables-page" data-testid="consumables-page">
      <div className="page-header">
        <h3>{translate('page.737c0b5f942e')}</h3>
      </div>
      <p className="field-hint">{translate('page.a381c267e0da')}</p>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null && action === null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <section data-testid="consumable-status-section" aria-label={translate('page.93b5ce3195e0')}>
        <p className="field-hint" data-testid="consumable-threshold-source">
          {thresholdSource.kind === 'loading'
            ? translate('ui.consumableThresholdLoading')
            : thresholdSource.kind === 'setting'
              ? translate('ui.consumableThresholdSetting', { version: thresholdSource.version })
              : translate('ui.consumableThresholdFallback', { reason: thresholdSource.reason })}
        </p>
        <FilterBar
          testId="consumable-status-filter"
          actions={
            <>
              <Button
                type="button"
                className="primary-button"
                data-testid="consumable-search"
                onClick={() =>
                  onApplyStatusFilter({
                    region: statusDraft.region.trim() === '' ? null : statusDraft.region.trim(),
                    subregion: statusDraft.subregion.trim() === '' ? null : statusDraft.subregion.trim(),
                    siteId: statusDraft.siteId.trim() === '' ? null : statusDraft.siteId.trim(),
                    connectivity: statusDraft.connectivity === '' ? null : statusDraft.connectivity,
                    keyword: statusDraft.keyword.trim() === '' ? null : statusDraft.keyword.trim(),
                    maxRemainingPercent:
                      statusDraft.maxRemainingPercent === '' ? null : Number(statusDraft.maxRemainingPercent),
                    consumableType: statusDraft.consumableType === '' ? null : statusDraft.consumableType,
                    customerId:
                      isPlatformRole && statusDraft.customerId.trim() !== '' ? statusDraft.customerId.trim() : null,
                  })
                }
              >
                {translate('page.f04090805c6e')}
              </Button>
              <Button
                type="button"
                data-testid="consumable-reset"
                onClick={() => {
                  setStatusDraft(EMPTY_STATUS_DRAFT);
                  onApplyStatusFilter({});
                }}
              >
                {translate('page.3d81345303ab')}
              </Button>
            </>
          }
        >
          <div className="filter-field">
            <label htmlFor="consumable-filter-region">{translate('page.17fc93c9cdbb')}</label>
            <Input
              id="consumable-filter-region"
              data-testid="consumable-filter-region"
              value={statusDraft.region}
              onChange={(event) => setStatusDraft({ ...statusDraft, region: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="consumable-filter-subregion">{translate('page.e1973949d60a')}</label>
            <Input
              id="consumable-filter-subregion"
              data-testid="consumable-filter-subregion"
              value={statusDraft.subregion}
              onChange={(event) => setStatusDraft({ ...statusDraft, subregion: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="consumable-filter-site">{translate('page.09232c5f3b50')}</label>
            <Input
              id="consumable-filter-site"
              data-testid="consumable-filter-site"
              value={statusDraft.siteId}
              onChange={(event) => setStatusDraft({ ...statusDraft, siteId: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="consumable-filter-connectivity">{translate('page.b639d60c4140')}</label>
            <select
              id="consumable-filter-connectivity"
              data-testid="consumable-filter-connectivity"
              value={statusDraft.connectivity}
              onChange={(event) =>
                setStatusDraft({
                  ...statusDraft,
                  connectivity: event.target.value === '' ? '' : (event.target.value as 'ONLINE' | 'OFFLINE'),
                })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              <option value="ONLINE">{translate('page.0373ff923114')}</option>
              <option value="OFFLINE">{translate('page.211357d22f4d')}</option>
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="consumable-filter-keyword">{translate('page.7f904bb70f96')}</label>
            <Input
              id="consumable-filter-keyword"
              data-testid="consumable-filter-keyword"
              value={statusDraft.keyword}
              onChange={(event) => setStatusDraft({ ...statusDraft, keyword: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="consumable-filter-max">{translate('page.c3d2894c6fdb')}</label>
            <Input
              id="consumable-filter-max"
              data-testid="consumable-filter-max"
              type="number"
              min={0}
              max={100}
              value={statusDraft.maxRemainingPercent}
              onChange={(event) => setStatusDraft({ ...statusDraft, maxRemainingPercent: event.target.value })}
            />
          </div>
          <div className="filter-field">
            <label htmlFor="consumable-filter-type">{translate('page.6c9da0502120')}</label>
            <select
              id="consumable-filter-type"
              data-testid="consumable-filter-type"
              value={statusDraft.consumableType}
              onChange={(event) =>
                setStatusDraft({
                  ...statusDraft,
                  consumableType: event.target.value === '' ? '' : (event.target.value as ConsumableType),
                })
              }
            >
              <option value="">{translate('page.31af9a60c654')}</option>
              {CONSUMABLE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CONSUMABLE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          {isPlatformRole ? (
            <div className="filter-field">
              <label htmlFor="consumable-filter-customer">{translate('page.a20148b7e39a')}</label>
              <Input
                id="consumable-filter-customer"
                data-testid="consumable-filter-customer"
                value={statusDraft.customerId}
                onChange={(event) => setStatusDraft({ ...statusDraft, customerId: event.target.value })}
              />
            </div>
          ) : null}
        </FilterBar>

        <section data-testid="consumable-table" aria-label={translate('page.079ec3477314')}>
          <CursorTable
            ariaLabel={translate('page.079ec3477314')}
            columns={[
              {
                key: 'region',
                header: translate('page.406e0f8c6852'),
                render: (row: ConsumableStatusView) => row.site?.region ?? '—',
              },
              { key: 'subregion', header: translate('page.ff0beacd69e2'), render: (row) => row.site?.subregion ?? '—' },
              { key: 'site', header: translate('page.619bc67325a4'), render: (row) => row.site?.name ?? '—' },
              { key: 'deviceId', header: translate('page.d79416b3896a'), render: (row) => row.deviceId },
              { key: 'alias', header: translate('page.270ec5a97320'), render: (row) => row.alias ?? '—' },
              {
                key: 'connectivity',
                header: translate('page.7328deebb5bc'),
                render: (row) =>
                  row.connectivity === 'ONLINE' ? translate('page.0373ff923114') : translate('page.211357d22f4d'),
              },
              {
                key: 'carbon',
                header: translate('page.ad9ca1dcb7cf'),
                render: (row) => (
                  <ConsumableCell
                    value={row.consumables.CARBON_FILTER}
                    testid={`consumable-carbon-${row.deviceId}`}
                    thresholds={thresholds}
                  />
                ),
              },
              {
                key: 'bio',
                header: translate('page.413b42e8c04e'),
                render: (row) => (
                  <ConsumableCell
                    value={row.consumables.BIO_ADDITIVE}
                    testid={`consumable-bio-${row.deviceId}`}
                    thresholds={thresholds}
                  />
                ),
              },
              {
                key: 'contact',
                header: translate('page.60beedc8f22b'),
                render: (row) => {
                  const contact = contacts[row.deviceId];
                  return contact?.kind === 'ready' ? (
                    <span data-testid={`consumable-contact-info-${row.deviceId}`}>
                      {contact.value.name ?? '—'} / {contact.value.phone ?? '—'} / {contact.value.email ?? '—'}
                    </span>
                  ) : contact?.kind === 'error' ? (
                    <ErrorNotice error={contact.error} />
                  ) : contact?.kind === 'loading' ? (
                    <span role="status">{translate('common.loading')}</span>
                  ) : (
                    <Button
                      type="button"
                      data-testid={`consumable-contact-${row.deviceId}`}
                      onClick={() => void loadContact(row.deviceId)}
                    >
                      {translate('page.60beedc8f22b')}
                    </Button>
                  );
                },
              },
            ]}
            rows={status.rows === null ? null : [...status.rows]}
            rowKey={(row) => row.deviceId}
            {...(status.loading !== undefined ? { loading: status.loading } : {})}
            {...(status.nextCursor !== undefined ? { nextCursor: status.nextCursor } : {})}
            {...(status.hasPrevPage !== undefined ? { hasPrevPage: status.hasPrevPage } : {})}
            onNextPage={onNextStatusPage}
            onPrevPage={onPrevStatusPage}
            {...(status.error !== undefined ? { error: status.error } : {})}
            onRefresh={onRefresh}
            emptyText={translate('page.1f98c9d3bc65')}
          />
        </section>
      </section>

      <section data-testid="consumable-requests-section" aria-label={translate('page.07c43eb2dde1')}>
        <div className="page-header">
          <h4>{translate('page.07c43eb2dde1')}</h4>
          <Button
            type="button"
            className="primary-button"
            data-testid="consumable-request-create-open"
            disabled={!canWrite || busy}
            {...(!canWrite ? { title: translate('page.250fd887db71') } : {})}
            onClick={() => {
              setCreateDraft(EMPTY_CREATE_DRAFT);
              setDeviceSearch('');
              setCreateError(null);
              setCreateOpen(true);
              void loadRequestDevices();
            }}
          >
            {translate('page.d772b092f68b')}
          </Button>
        </div>
        <FilterBar
          testId="consumable-request-filter"
          actions={
            <Button
              type="button"
              className="primary-button"
              data-testid="request-filter-search"
              onClick={() =>
                onApplyRequestFilter({
                  status: requestDraft.status === '' ? null : requestDraft.status,
                  consumableType: requestDraft.consumableType === '' ? null : requestDraft.consumableType,
                  deviceId: requestDraft.deviceId.trim() === '' ? null : requestDraft.deviceId.trim(),
                })
              }
            >
              {translate('page.dcce9a144a40')}
            </Button>
          }
        >
          <div className="filter-field">
            <label htmlFor="request-filter-status">{translate('page.8542beb99054')}</label>
            <select
              id="request-filter-status"
              data-testid="request-filter-status"
              value={requestDraft.status}
              onChange={(event) =>
                setRequestDraft({
                  ...requestDraft,
                  status: event.target.value === '' ? '' : (event.target.value as ConsumableRequestStatus),
                })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              {REQUEST_STATUS_OPTIONS.map((statusOption) => (
                <option key={statusOption} value={statusOption}>
                  {REQUEST_STATUS_LABELS[statusOption]}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="request-filter-type">{translate('page.6c9da0502120')}</label>
            <select
              id="request-filter-type"
              data-testid="request-filter-type"
              value={requestDraft.consumableType}
              onChange={(event) =>
                setRequestDraft({
                  ...requestDraft,
                  consumableType: event.target.value === '' ? '' : (event.target.value as ConsumableType),
                })
              }
            >
              <option value="">{translate('page.778fc8f99453')}</option>
              {CONSUMABLE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {CONSUMABLE_TYPE_LABELS[type]}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label htmlFor="request-filter-device">{translate('page.9a04e46a8d92')}</label>
            <Input
              id="request-filter-device"
              data-testid="request-filter-device"
              value={requestDraft.deviceId}
              onChange={(event) => setRequestDraft({ ...requestDraft, deviceId: event.target.value })}
            />
          </div>
        </FilterBar>

        <section data-testid="consumable-requests-table" aria-label={translate('page.ea93d111282f')}>
          <CursorTable
            ariaLabel={translate('page.ea93d111282f')}
            columns={[
              {
                key: 'requestedAt',
                header: translate('page.7ec0fb7045d8'),
                render: (req: ConsumableRequestView) => <TimeText iso={req.requestedAt} />,
              },
              { key: 'deviceId', header: translate('page.01f2c16cda65'), render: (req) => req.deviceId },
              {
                key: 'consumableType',
                header: translate('page.6c9da0502120'),
                render: (req) => CONSUMABLE_TYPE_LABELS[req.consumableType],
              },
              {
                key: 'status',
                header: translate('page.8542beb99054'),
                render: (req) => (
                  <span data-testid={`consumable-request-status-${req.requestId}`}>
                    {REQUEST_STATUS_LABELS[req.status]}
                  </span>
                ),
              },
              { key: 'requestedBy', header: translate('page.880ab989a872'), render: (req) => req.requestedBy },
              { key: 'processedBy', header: translate('page.3e132a2a8e75'), render: (req) => req.processedBy ?? '—' },
              {
                key: 'stageNotes',
                header: translate('consumables.stageNotes'),
                render: (req) => <RequestNotes request={req} />,
              },
              {
                key: 'completedAt',
                header: translate('page.754a8a2e2dba'),
                render: (req) => (req.completedAt !== null ? <TimeText iso={req.completedAt} /> : '—'),
              },
              {
                key: 'actions',
                header: translate('page.f3ea6d345e2a'),
                render: (req) => (
                  <span className="action-row">
                    {(['process', 'complete', 'cancel'] as const).map((requestAction) => {
                      const denied = gateRequestAction(requestAction, req.status, role);
                      // 仅渲染矩阵内动作（跳级动作不渲染按钮）
                      if (denied !== null && denied.includes(translate('page.41cd13289ce7'))) return null;
                      return (
                        <Button
                          key={requestAction}
                          type="button"
                          data-testid={`consumable-${requestAction}-${req.requestId}`}
                          disabled={busy || denied !== null}
                          {...(denied !== null ? { title: denied } : {})}
                          onClick={() => {
                            setAction({ action: requestAction, request: req });
                            setActionError(null);
                            setActionNote('');
                          }}
                        >
                          {REQUEST_ACTION_LABELS[requestAction]}
                        </Button>
                      );
                    })}
                  </span>
                ),
              },
            ]}
            rows={requests.rows === null ? null : [...requests.rows]}
            rowKey={(req) => req.requestId}
            {...(requests.error !== undefined ? { error: requests.error } : {})}
            onRefresh={onRefresh}
            emptyText={translate('page.24e8533ea7aa')}
          />
        </section>
      </section>

      <Modal
        open={action !== null}
        title={
          action !== null
            ? REQUEST_ACTION_LABELS[action.action] + translate('page.41cb070d0772') + action.request.requestId
            : ''
        }
        testid="consumable-action-form"
        onClose={() => {
          if (busy) return;
          setAction(null);
          setActionError(null);
        }}
      >
        {actionCopy !== null && action !== null ? (
          <div>
            <p className="field-hint" id="consumable-action-description">
              {translate(actionCopy.description)}
            </p>
            {actionError !== null ? <ErrorNotice error={actionError} onRefresh={refreshAfterConflict} /> : null}
            {conflictCode === 'CONFLICT' ? (
              <Button type="button" onClick={refreshAfterConflict}>
                {translate('common.refresh')}
              </Button>
            ) : null}
            <div className="dialog-field">
              <label htmlFor="consumable-action-note">{translate(actionCopy.noteLabel)}</label>
              <TextArea
                id="consumable-action-note"
                data-testid="consumable-action-note"
                aria-describedby="consumable-action-description"
                rows={3}
                maxLength={500}
                required={noteRequired}
                value={actionNote}
                onChange={(event) => setActionNote(event.target.value)}
              />
            </div>
            {noteError !== null ? (
              <p className="field-hint" data-testid="consumable-action-note-error">
                {noteError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Button
                type="button"
                className="primary-button"
                data-testid="consumable-action-submit"
                disabled={
                  busy || noteError !== null || conflictCode === 'CONFLICT' || conflictCode === 'VERSION_CONFLICT'
                }
                onClick={() => void submitAction()}
              >
                {translate('page.b56d9ac6c5a0')}
                {REQUEST_ACTION_LABELS[action.action]}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={createOpen}
        title={translate('page.42438fcdc1eb')}
        testid="consumable-create-form"
        onClose={closeCreate}
      >
        {createError !== null ? <ErrorNotice error={createError} /> : null}
        {deviceOptions.kind === 'ready' && deviceOptions.options.length > 0 ? (
          <div className="dialog-field">
            <label htmlFor="consumable-device-search">{translate('consumables.searchDevices')}</label>
            <Input
              id="consumable-device-search"
              value={deviceSearch}
              disabled={busy}
              onChange={(event) => setDeviceSearch(event.target.value)}
            />
          </div>
        ) : null}
        <div className="dialog-field">
          <label htmlFor="consumable-create-device">{translate('page.9a04e46a8d92')}</label>
          <select
            id="consumable-create-device"
            data-testid="consumable-create-device"
            value={createDraft.deviceId}
            disabled={busy || visibleDevices.length === 0}
            aria-invalid={deviceError !== null}
            aria-describedby="consumable-device-feedback"
            onChange={(event) => {
              setCreateDraft({ ...createDraft, deviceId: event.target.value });
              setDeviceError(null);
            }}
          >
            <option value="">{translate('devicePicker.choose')}</option>
            {visibleDevices.map((device) => (
              <option key={device.value} value={device.value}>
                {device.label}
              </option>
            ))}
          </select>
          <div id="consumable-device-feedback">
            {deviceError !== null ? (
              <p className="field-hint" role="alert" data-testid="consumable-device-error">
                {deviceError}
              </p>
            ) : null}
            {deviceOptions.kind === 'loading' ? <p role="status">{translate('devicePicker.loading')}</p> : null}
            {deviceOptions.kind === 'ready' && visibleDevices.length === 0 ? (
              <p role="status">
                {translate(search === '' ? 'consumables.noEligibleDevices' : 'consumables.noMatchingDevices')}
              </p>
            ) : null}
            {deviceOptions.kind === 'error' ? <ErrorNotice error={deviceOptions.error} /> : null}
            {deviceOptions.kind === 'error' || deviceError !== null ? (
              <Button type="button" disabled={busy} onClick={() => void loadRequestDevices()}>
                {translate('devicePicker.retry')}
              </Button>
            ) : null}
          </div>
        </div>
        <div className="dialog-field">
          <label htmlFor="consumable-create-type">{translate('page.6c9da0502120')}</label>
          <select
            id="consumable-create-type"
            data-testid="consumable-create-type"
            value={createDraft.consumableType}
            onChange={(event) =>
              setCreateDraft({ ...createDraft, consumableType: event.target.value as ConsumableType | '' })
            }
          >
            <option value="">{translate('page.382f4b5559b3')}</option>
            {CONSUMABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {CONSUMABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-field">
          <label htmlFor="consumable-create-note">{translate('consumables.requestNote')}</label>
          <Input
            id="consumable-create-note"
            data-testid="consumable-create-note"
            maxLength={500}
            value={createDraft.note}
            onChange={(event) => setCreateDraft({ ...createDraft, note: event.target.value })}
          />
        </div>
        <div className="dialog-actions">
          <Button type="button" onClick={closeCreate}>
            {translate('common.cancel')}
          </Button>
          <Button
            type="button"
            className="primary-button"
            data-testid="consumable-create-submit"
            disabled={busy || !canWrite || !deviceEligible || createDraft.consumableType === ''}
            onClick={submitCreate}
          >
            {translate('page.7bc5480e718b')}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
