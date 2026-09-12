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
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
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
    readonly error?: unknown;
  };
  readonly statusFilter: ConsumableStatusFilter;
  readonly onApplyStatusFilter: (filter: ConsumableStatusFilter) => void;
  readonly onLoadContact: (deviceId: string) => Promise<ConsumableContactView>;
  readonly requests: {
    readonly rows: readonly ConsumableRequestView[] | null;
    readonly error?: unknown;
  };
  readonly requestFilter: ConsumableRequestFilter;
  readonly onApplyRequestFilter: (filter: ConsumableRequestFilter) => void;
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
      {value.remainingDisplay}
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
  onLoadContact,
  requests,
  requestFilter,
  onApplyRequestFilter,
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
  const [createDraft, setCreateDraft] = useState({ deviceId: '', consumableType: '' as ConsumableType | '', note: '' });
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const isPlatformRole = !role.startsWith('Customer');
  const canWrite = canWriteDevices(role);
  const noteRequired = action?.action !== 'process';
  const noteError = action !== null ? validateRequestNote(actionNote, noteRequired) : null;
  const loadContact = async (deviceId: string) => {
    setContacts((current) => ({ ...current, [deviceId]: { kind: 'loading' } }));
    try {
      const value = await onLoadContact(deviceId);
      setContacts((current) => ({ ...current, [deviceId]: { kind: 'ready', value } }));
    } catch (error) {
      setContacts((current) => ({ ...current, [deviceId]: { kind: 'error', error } }));
    }
  };
  const runAction = async (execute: () => Promise<string>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      setNotice(await execute());
      setAction(null);
      setCreateOpen(false);
      onRefresh();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const submitAction = () =>
    runAction(async () => {
      if (action === null) return '';
      const note = actionNote.trim();
      if (action.action === 'process') {
        await onProcess(action.request.requestId, note === '' ? null : note, action.request.version);
        return translate('page.bfdd7ddce562') + ' ' + action.request.requestId + (' ' + translate('page.97930c3c7beb'));
      }
      if (action.action === 'complete') {
        await onComplete(action.request.requestId, note, action.request.version);
        return translate('page.bfdd7ddce562') + ' ' + action.request.requestId + (' ' + translate('page.e99b48a29bdf'));
      }
      await onCancel(action.request.requestId, note, action.request.version);
      return translate('page.bfdd7ddce562') + ' ' + action.request.requestId + (' ' + translate('page.a5ffdc95eeb0'));
    });
  const submitCreate = () =>
    runAction(async () => {
      const result = await onCreateRequest(
        createDraft.deviceId.trim(),
        createDraft.consumableType as ConsumableType,
        createDraft.note.trim() === '' ? undefined : createDraft.note.trim(),
      );
      setCreateDraft({ deviceId: '', consumableType: '', note: '' });
      return result.replayed
        ? translate('page.46c2995a52f6')
        : translate('page.2070de48878e') + result.request.requestId + '\uFF09';
    });
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
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <section data-testid="consumable-status-section" aria-label={translate('page.93b5ce3195e0')}>
        <p className="field-hint" data-testid="consumable-threshold-source">
          {thresholdSource.kind === 'loading'
            ? translate('ui.consumableThresholdLoading')
            : thresholdSource.kind === 'setting'
              ? translate('ui.consumableThresholdSetting', { version: thresholdSource.version })
              : translate('ui.consumableThresholdFallback', { reason: thresholdSource.reason })}
        </p>
        <div className="filter-bar">
          <label htmlFor="consumable-filter-region">{translate('page.17fc93c9cdbb')}</label>
          <input
            id="consumable-filter-region"
            data-testid="consumable-filter-region"
            value={statusDraft.region}
            onChange={(event) => setStatusDraft({ ...statusDraft, region: event.target.value })}
          />
          <label htmlFor="consumable-filter-subregion">{translate('page.e1973949d60a')}</label>
          <input
            id="consumable-filter-subregion"
            data-testid="consumable-filter-subregion"
            value={statusDraft.subregion}
            onChange={(event) => setStatusDraft({ ...statusDraft, subregion: event.target.value })}
          />
          <label htmlFor="consumable-filter-site">{translate('page.09232c5f3b50')}</label>
          <input
            id="consumable-filter-site"
            data-testid="consumable-filter-site"
            value={statusDraft.siteId}
            onChange={(event) => setStatusDraft({ ...statusDraft, siteId: event.target.value })}
          />
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
          <label htmlFor="consumable-filter-keyword">{translate('page.7f904bb70f96')}</label>
          <input
            id="consumable-filter-keyword"
            data-testid="consumable-filter-keyword"
            value={statusDraft.keyword}
            onChange={(event) => setStatusDraft({ ...statusDraft, keyword: event.target.value })}
          />
          <label htmlFor="consumable-filter-max">{translate('page.c3d2894c6fdb')}</label>
          <input
            id="consumable-filter-max"
            data-testid="consumable-filter-max"
            type="number"
            min={0}
            max={100}
            value={statusDraft.maxRemainingPercent}
            onChange={(event) => setStatusDraft({ ...statusDraft, maxRemainingPercent: event.target.value })}
          />
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
          {isPlatformRole ? (
            <>
              <label htmlFor="consumable-filter-customer">{translate('page.a20148b7e39a')}</label>
              <input
                id="consumable-filter-customer"
                data-testid="consumable-filter-customer"
                value={statusDraft.customerId}
                onChange={(event) => setStatusDraft({ ...statusDraft, customerId: event.target.value })}
              />
            </>
          ) : null}
          <button
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
          </button>
          <button
            type="button"
            data-testid="consumable-reset"
            onClick={() => {
              setStatusDraft(EMPTY_STATUS_DRAFT);
              onApplyStatusFilter({});
            }}
          >
            {translate('page.3d81345303ab')}
          </button>
        </div>

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
                    <button
                      type="button"
                      data-testid={`consumable-contact-${row.deviceId}`}
                      onClick={() => void loadContact(row.deviceId)}
                    >
                      {translate('page.60beedc8f22b')}
                    </button>
                  );
                },
              },
            ]}
            rows={status.rows === null ? null : [...status.rows]}
            rowKey={(row) => row.deviceId}
            {...(status.error !== undefined ? { error: status.error } : {})}
            onRefresh={onRefresh}
            emptyText={translate('page.1f98c9d3bc65')}
          />
        </section>
      </section>

      <section data-testid="consumable-requests-section" aria-label={translate('page.07c43eb2dde1')}>
        <div className="page-header">
          <h4>{translate('page.07c43eb2dde1')}</h4>
          <button
            type="button"
            className="primary-button"
            data-testid="consumable-request-create-open"
            disabled={!canWrite || busy}
            {...(!canWrite ? { title: translate('page.250fd887db71') } : {})}
            onClick={() => setCreateOpen(true)}
          >
            {translate('page.d772b092f68b')}
          </button>
        </div>
        <div className="filter-bar">
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
          <label htmlFor="request-filter-device">{translate('page.9a04e46a8d92')}</label>
          <input
            id="request-filter-device"
            data-testid="request-filter-device"
            value={requestDraft.deviceId}
            onChange={(event) => setRequestDraft({ ...requestDraft, deviceId: event.target.value })}
          />
          <button
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
          </button>
        </div>

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
              { key: 'processNote', header: translate('page.9019638102fb'), render: (req) => req.processNote ?? '—' },
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
                        <button
                          key={requestAction}
                          type="button"
                          data-testid={`consumable-${requestAction}-${req.requestId}`}
                          disabled={busy || denied !== null}
                          {...(denied !== null ? { title: denied } : {})}
                          onClick={() => {
                            setAction({ action: requestAction, request: req });
                            setActionNote('');
                          }}
                        >
                          {REQUEST_ACTION_LABELS[requestAction]}
                        </button>
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
        onClose={() => setAction(null)}
      >
        {action !== null ? (
          <div>
            <p className="field-hint">
              If-Match：v{action.request.version}；
              {action.action === 'process' ? translate('page.4c3750f2c04b') : translate('page.3ed45d0380ff')}
              {translate('page.ff917d9f5ac3')}
            </p>
            <div className="dialog-field">
              <label htmlFor="consumable-action-note">{translate('page.9019638102fb')}</label>
              <input
                id="consumable-action-note"
                data-testid="consumable-action-note"
                maxLength={500}
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
              <button
                type="button"
                className="primary-button"
                data-testid="consumable-action-submit"
                disabled={busy || noteError !== null}
                onClick={() => void submitAction()}
              >
                {translate('page.b56d9ac6c5a0')}
                {REQUEST_ACTION_LABELS[action.action]}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={createOpen}
        title={translate('page.42438fcdc1eb')}
        testid="consumable-create-form"
        onClose={() => setCreateOpen(false)}
      >
        <div className="dialog-field">
          <label htmlFor="consumable-create-device">{translate('page.9a04e46a8d92')}</label>
          <input
            id="consumable-create-device"
            data-testid="consumable-create-device"
            value={createDraft.deviceId}
            onChange={(event) => setCreateDraft({ ...createDraft, deviceId: event.target.value })}
          />
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
          <label htmlFor="consumable-create-note">{translate('page.bf243804ac18')}</label>
          <input
            id="consumable-create-note"
            data-testid="consumable-create-note"
            maxLength={500}
            value={createDraft.note}
            onChange={(event) => setCreateDraft({ ...createDraft, note: event.target.value })}
          />
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button"
            data-testid="consumable-create-submit"
            disabled={busy || createDraft.deviceId.trim() === '' || createDraft.consumableType === ''}
            onClick={() => void submitCreate()}
          >
            {translate('page.7bc5480e718b')}
          </button>
        </div>
      </Modal>
    </div>
  );
}
