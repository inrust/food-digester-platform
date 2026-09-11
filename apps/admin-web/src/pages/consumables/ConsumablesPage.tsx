/**
 * FE-18 耗材状态与更换申请页（/consumables）：耗材列表 + 更换申请两区域。
 *
 * - 耗材列表：Region/Subregion/Site、连接状态、关键字（ID/序列号/别名）、阈值筛选；
 *   显示标准耗材名称、百分比（unknown 仅文本不画进度条）、observedAt/stale 徽标；
 *   阈值颜色（<10%/10~30%/>30%）为暂定展示阈值，由 prop（字典/配置）驱动；
 * - 联系方式：点击后按权限展示同一授权响应中的 contact；无权限（null）不显示号码；
 * - 更换申请：PENDING→PROCESSING→COMPLETED/CANCELLED，操作携带 version + 备注
 *   （complete/cancel 强制）；重复创建幂等（replayed 提示）；跳级由矩阵禁用 + 服务端 409；
 * - 边界：不预测寿命、不直接联系、不做库存/派单；协议冻结前无“来自设备”入口（source=ADMIN）。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import type { ConsumableRequestFilter, ConsumableStatusFilter } from './consumables-api.js';
import {
  CONSUMABLE_TYPES,
  CONSUMABLE_TYPE_LABELS,
  DEFAULT_THRESHOLDS,
  REQUEST_ACTION_LABELS,
  REQUEST_STATUS_LABELS,
  REQUEST_STATUS_OPTIONS,
  canWriteDevices,
  gateRequestAction,
  thresholdLevel,
  validateRequestNote,
} from './consumable-state.js';
import type { ConsumableThresholds, RequestAction } from './consumable-state.js';
import type {
  ConsumableRequestCreateResult,
  ConsumableRequestStatus,
  ConsumableRequestView,
  ConsumableStatusView,
  ConsumableType,
  ConsumableValueView,
} from './types.js';

export interface ConsumablesPageProps {
  readonly role: Role;
  readonly status: { readonly rows: readonly ConsumableStatusView[] | null; readonly error?: unknown };
  readonly statusFilter: ConsumableStatusFilter;
  readonly onApplyStatusFilter: (filter: ConsumableStatusFilter) => void;
  readonly requests: { readonly rows: readonly ConsumableRequestView[] | null; readonly error?: unknown };
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
  /** 展示阈值（字典/配置驱动；缺省暂定 10/30）。 */
  readonly thresholds?: ConsumableThresholds;
}

type ActionTarget = { readonly action: RequestAction; readonly request: ConsumableRequestView };

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
        unknown（未上报）
        {value?.stale === true ? <span className="stale-badge">数据过期</span> : null}
      </span>
    );
  }
  const level = thresholdLevel(value.remainingPercent, thresholds);
  return (
    <span data-testid={testid}>
      <span className="consumable-bar" data-level={level ?? 'ok'} style={{ width: `${value.remainingPercent}%` }} />
      {value.remainingDisplay}
      {value.stale ? <span className="stale-badge">数据过期</span> : null}
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
  requests,
  requestFilter,
  onApplyRequestFilter,
  onCreateRequest,
  onProcess,
  onComplete,
  onCancel,
  onRefresh,
  thresholds = DEFAULT_THRESHOLDS,
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
  const [contactOpen, setContactOpen] = useState<Readonly<Record<string, boolean>>>({});
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
        return `申请 ${action.request.requestId} 已进入处理`;
      }
      if (action.action === 'complete') {
        await onComplete(action.request.requestId, note, action.request.version);
        return `申请 ${action.request.requestId} 已完成`;
      }
      await onCancel(action.request.requestId, note, action.request.version);
      return `申请 ${action.request.requestId} 已取消`;
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
        ? '已存在同设备同耗材的开放申请（幂等返回现有记录，未重复创建）'
        : `更换申请已创建（${result.request.requestId}）`;
    });

  return (
    <div className="consumables-page" data-testid="consumables-page">
      <div className="page-header">
        <h3>耗材查看</h3>
      </div>
      <p className="field-hint">
        仅展示设备上报值（未上报显示 unknown，不臆测）；阈值颜色为暂定展示阈值（由字典/配置驱动）；
        不预测寿命、不直接联系客户、不做库存/派单。
      </p>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <section data-testid="consumable-status-section" aria-label="耗材状态">
        <div className="filter-bar">
          <label htmlFor="consumable-filter-region">区域</label>
          <input
            id="consumable-filter-region"
            data-testid="consumable-filter-region"
            value={statusDraft.region}
            onChange={(event) => setStatusDraft({ ...statusDraft, region: event.target.value })}
          />
          <label htmlFor="consumable-filter-subregion">子区域</label>
          <input
            id="consumable-filter-subregion"
            data-testid="consumable-filter-subregion"
            value={statusDraft.subregion}
            onChange={(event) => setStatusDraft({ ...statusDraft, subregion: event.target.value })}
          />
          <label htmlFor="consumable-filter-site">站点 ID</label>
          <input
            id="consumable-filter-site"
            data-testid="consumable-filter-site"
            value={statusDraft.siteId}
            onChange={(event) => setStatusDraft({ ...statusDraft, siteId: event.target.value })}
          />
          <label htmlFor="consumable-filter-connectivity">连接状态</label>
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
            <option value="">全部</option>
            <option value="ONLINE">在线</option>
            <option value="OFFLINE">离线</option>
          </select>
          <label htmlFor="consumable-filter-keyword">ID/别名</label>
          <input
            id="consumable-filter-keyword"
            data-testid="consumable-filter-keyword"
            value={statusDraft.keyword}
            onChange={(event) => setStatusDraft({ ...statusDraft, keyword: event.target.value })}
          />
          <label htmlFor="consumable-filter-max">剩余 ≤</label>
          <input
            id="consumable-filter-max"
            data-testid="consumable-filter-max"
            type="number"
            min={0}
            max={100}
            value={statusDraft.maxRemainingPercent}
            onChange={(event) => setStatusDraft({ ...statusDraft, maxRemainingPercent: event.target.value })}
          />
          <label htmlFor="consumable-filter-type">耗材</label>
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
            <option value="">任一</option>
            {CONSUMABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {CONSUMABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          {isPlatformRole ? (
            <>
              <label htmlFor="consumable-filter-customer">客户 ID</label>
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
                maxRemainingPercent: statusDraft.maxRemainingPercent === '' ? null : Number(statusDraft.maxRemainingPercent),
                consumableType: statusDraft.consumableType === '' ? null : statusDraft.consumableType,
                customerId: isPlatformRole && statusDraft.customerId.trim() !== '' ? statusDraft.customerId.trim() : null,
              })
            }
          >
            搜索
          </button>
          <button
            type="button"
            data-testid="consumable-reset"
            onClick={() => {
              setStatusDraft(EMPTY_STATUS_DRAFT);
              onApplyStatusFilter({});
            }}
          >
            重置
          </button>
        </div>

        <section data-testid="consumable-table" aria-label="耗材列表">
          <CursorTable
            ariaLabel="耗材列表"
            columns={[
              { key: 'region', header: '设备区域', render: (row: ConsumableStatusView) => row.site?.region ?? '—' },
              { key: 'subregion', header: '设备子区域', render: (row) => row.site?.subregion ?? '—' },
              { key: 'site', header: '站点', render: (row) => row.site?.name ?? '—' },
              { key: 'deviceId', header: '设备唯一ID', render: (row) => row.deviceId },
              { key: 'alias', header: '设备别名', render: (row) => row.alias ?? '—' },
              {
                key: 'connectivity',
                header: '连接',
                render: (row) => (row.connectivity === 'ONLINE' ? '在线' : '离线'),
              },
              {
                key: 'carbon',
                header: '碳包预估剩余百分比',
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
                header: '活性菌预估剩余百分比',
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
                header: '联系方式',
                render: (row) =>
                  contactOpen[row.deviceId] === true ? (
                    row.contact !== null ? (
                      <span data-testid={`consumable-contact-info-${row.deviceId}`}>
                        {row.contact.name ?? '—'} / {row.contact.phone ?? '—'} / {row.contact.email ?? '—'}
                      </span>
                    ) : (
                      <span className="field-hint" data-testid={`consumable-contact-info-${row.deviceId}`}>
                        无权限查看联系方式
                      </span>
                    )
                  ) : (
                    <button
                      type="button"
                      data-testid={`consumable-contact-${row.deviceId}`}
                      onClick={() => setContactOpen({ ...contactOpen, [row.deviceId]: true })}
                    >
                      联系方式
                    </button>
                  ),
              },
            ]}
            rows={status.rows === null ? null : [...status.rows]}
            rowKey={(row) => row.deviceId}
            {...(status.error !== undefined ? { error: status.error } : {})}
            onRefresh={onRefresh}
            emptyText="暂无耗材状态"
          />
        </section>
      </section>

      <section data-testid="consumable-requests-section" aria-label="更换申请">
        <div className="page-header">
          <h4>更换申请</h4>
          <button
            type="button"
            className="primary-button"
            data-testid="consumable-request-create-open"
            disabled={!canWrite || busy}
            {...(!canWrite ? { title: '需要设备写权限（device:write）' } : {})}
            onClick={() => setCreateOpen(true)}
          >
            新建申请
          </button>
        </div>
        <div className="filter-bar">
          <label htmlFor="request-filter-status">处理状态</label>
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
            <option value="">全部</option>
            {REQUEST_STATUS_OPTIONS.map((statusOption) => (
              <option key={statusOption} value={statusOption}>
                {REQUEST_STATUS_LABELS[statusOption]}
              </option>
            ))}
          </select>
          <label htmlFor="request-filter-type">耗材</label>
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
            <option value="">全部</option>
            {CONSUMABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {CONSUMABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <label htmlFor="request-filter-device">设备 ID</label>
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
            筛选
          </button>
        </div>

        <section data-testid="consumable-requests-table" aria-label="更换申请列表">
          <CursorTable
            ariaLabel="更换申请列表"
            columns={[
              {
                key: 'requestedAt',
                header: '用户申请时间',
                render: (req: ConsumableRequestView) => <TimeText iso={req.requestedAt} />,
              },
              { key: 'deviceId', header: '设备', render: (req) => req.deviceId },
              {
                key: 'consumableType',
                header: '耗材',
                render: (req) => CONSUMABLE_TYPE_LABELS[req.consumableType],
              },
              {
                key: 'status',
                header: '处理状态',
                render: (req) => (
                  <span data-testid={`consumable-request-status-${req.requestId}`}>
                    {REQUEST_STATUS_LABELS[req.status]}
                  </span>
                ),
              },
              { key: 'requestedBy', header: '申请人', render: (req) => req.requestedBy },
              { key: 'processedBy', header: '处理人', render: (req) => req.processedBy ?? '—' },
              { key: 'processNote', header: '处理备注', render: (req) => req.processNote ?? '—' },
              {
                key: 'completedAt',
                header: '完成时间',
                render: (req) => (req.completedAt !== null ? <TimeText iso={req.completedAt} /> : '—'),
              },
              {
                key: 'actions',
                header: '操作',
                render: (req) => (
                  <span className="action-row">
                    {(['process', 'complete', 'cancel'] as const).map((requestAction) => {
                      const denied = gateRequestAction(requestAction, req.status, role);
                      // 仅渲染矩阵内动作（跳级动作不渲染按钮）
                      if (denied !== null && denied.includes('不允许')) return null;
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
            emptyText="暂无更换申请"
          />
        </section>
      </section>

      <Modal
        open={action !== null}
        title={action !== null ? `${REQUEST_ACTION_LABELS[action.action]}申请：${action.request.requestId}` : ''}
        testid="consumable-action-form"
        onClose={() => setAction(null)}
      >
        {action !== null ? (
          <div>
            <p className="field-hint">
              If-Match：v{action.request.version}；{action.action === 'process' ? '处理备注可选' : '处理备注/原因强制'}；
              状态迁移被拒绝（跳级/漂移）→ 409。
            </p>
            <div className="dialog-field">
              <label htmlFor="consumable-action-note">处理备注</label>
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
                确认{REQUEST_ACTION_LABELS[action.action]}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={createOpen} title="新建更换申请" testid="consumable-create-form" onClose={() => setCreateOpen(false)}>
        <div className="dialog-field">
          <label htmlFor="consumable-create-device">设备 ID</label>
          <input
            id="consumable-create-device"
            data-testid="consumable-create-device"
            value={createDraft.deviceId}
            onChange={(event) => setCreateDraft({ ...createDraft, deviceId: event.target.value })}
          />
        </div>
        <div className="dialog-field">
          <label htmlFor="consumable-create-type">耗材</label>
          <select
            id="consumable-create-type"
            data-testid="consumable-create-type"
            value={createDraft.consumableType}
            onChange={(event) =>
              setCreateDraft({ ...createDraft, consumableType: event.target.value as ConsumableType | '' })
            }
          >
            <option value="">请选择</option>
            {CONSUMABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {CONSUMABLE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-field">
          <label htmlFor="consumable-create-note">申请备注（可选）</label>
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
            创建申请
          </button>
        </div>
      </Modal>
    </div>
  );
}
