/**
 * FE-13 固件包页（/ota/packages）：上传会话（元数据 + 签名 → 预签名 URL）→ 浏览器直传
 * 对象存储 → complete 校验（对象/大小/SHA-256/签名/病毒扫描全过 → VERIFIED 不可变）；
 * 包列表（可发布 = status VERIFIED；UPLOADED 不进入可发布列表）。
 *
 * - 页面不持有对象存储密钥、不生成上传 URL：直传由容器经 onUploadAndComplete 装配；
 * - 同型号+版本+packageType 重复 → 409 可读错误；VERIFIED 重复完成 → 409 不可覆盖；
 * - 预签名 URL 过期（900s 暂定）需重建会话；详情不展示预签名 URL/信任根材料；
 * - 写操作需 ota:write（Auditor 只读）；功能边界：不实现设备端验签/安装/回滚。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { hasPermission } from '@fdp/auth/browser';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import type { PackageListFilter } from './ota-api.js';
import {
  MAX_PACKAGE_SIZE_BYTES,
  PACKAGE_STATUS_LABELS,
  PACKAGE_STATUS_OPTIONS,
  PACKAGE_TYPE_LABELS,
  PACKAGE_TYPE_OPTIONS,
  hasUploadErrors,
  validateUploadMetadata,
} from './ota-state.js';
import type { UploadMetadataDraft } from './ota-state.js';
import type {
  FirmwarePackageStatus,
  FirmwarePackageType,
  FirmwarePackageView,
  FirmwareUploadSessionCreate,
  FirmwareUploadSessionView,
  OtaListState,
} from './types.js';

export interface OtaPackagesPageProps {
  readonly role: Role;
  readonly packages: OtaListState<FirmwarePackageView>;
  readonly filter: PackageListFilter;
  readonly onApplyFilter: (filter: PackageListFilter) => void;
  readonly onLoadMore: (cursor: string) => void;
  /** 创建上传会话（声明元数据 + 签名 → 短期预签名上传 URL）。 */
  readonly onCreateUploadSession: (input: FirmwareUploadSessionCreate) => Promise<FirmwareUploadSessionView>;
  /** 直传对象存储（预签名 URL）后提交 complete 校验；返回校验后的包（VERIFIED）。 */
  readonly onUploadAndComplete: (session: FirmwareUploadSessionView, file: File) => Promise<FirmwarePackageView>;
  readonly onRefresh: () => void;
  readonly onNavigate: (path: string) => void;
}

const EMPTY_DRAFT: UploadMetadataDraft & { packageType: FirmwarePackageType } = {
  model: '',
  version: '',
  packageType: 'FIRMWARE',
  sizeBytes: '',
  sha256: '',
  signature: '',
};

export function OtaPackagesPage({
  role,
  packages,
  filter,
  onApplyFilter,
  onLoadMore,
  onCreateUploadSession,
  onUploadAndComplete,
  onRefresh,
  onNavigate,
}: OtaPackagesPageProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [session, setSession] = useState<FirmwareUploadSessionView | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [verified, setVerified] = useState<FirmwarePackageView | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftFilter, setDraftFilter] = useState<PackageListFilter>(filter);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const canWrite = hasPermission(role, 'ota:write');
  const fieldErrors = validateUploadMetadata(draft);

  const runAction = async (execute: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await execute();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const submitSession = () =>
    runAction(async () => {
      const created = await onCreateUploadSession({
        model: draft.model.trim(),
        version: draft.version.trim(),
        packageType: draft.packageType,
        sizeBytes: Number(draft.sizeBytes),
        sha256: draft.sha256.trim(),
        signature: draft.signature.trim(),
      });
      setSession(created);
      setUploadFile(null);
      setFormOpen(false);
      setNotice(`上传会话已创建（${created.packageId}）；请在 URL 过期前完成直传`);
    });

  const submitComplete = () =>
    runAction(async () => {
      if (session === null || uploadFile === null) return;
      const pkg = await onUploadAndComplete(session, uploadFile);
      setVerified(pkg);
      setSession(null);
      setNotice(
        pkg.status === 'VERIFIED'
          ? `校验通过，包 ${pkg.packageId} 已进入可发布（VERIFIED，不可变）`
          : `校验已提交，当前状态：${PACKAGE_STATUS_LABELS[pkg.status]}`,
      );
      onRefresh();
    });

  return (
    <div className="ota-packages-page" data-testid="ota-packages-page">
      <div className="page-header">
        <h3>固件包管理</h3>
        <button type="button" data-testid="goto-ota-campaigns" onClick={() => onNavigate('/ota/campaigns')}>
          前往 OTA 升级
        </button>
      </div>

      <section data-testid="package-upload" aria-label="固件上传">
        <h4>固件上传</h4>
        <p className="field-hint">
          声明元数据与签名创建上传会话 → 浏览器经预签名 URL 直传对象存储（不经管理端中转）→
          提交校验（对象/大小/SHA-256/签名/病毒扫描全过 → VERIFIED 不可变）。
        </p>
        <button
          type="button"
          className="primary-button"
          data-testid="upload-session-open"
          disabled={!canWrite || busy}
          {...(!canWrite ? { title: '需要 OTA 写权限（ota:write）' } : {})}
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setSession(null);
            setVerified(null);
            setActionError(null);
            setFormOpen(true);
          }}
        >
          新建上传会话
        </button>
        {!canWrite ? (
          <span className="deny-reason" data-testid="upload-deny">
            需要 OTA 写权限（ota:write）
          </span>
        ) : null}

        {session !== null ? (
          <div className="upload-session" data-testid="upload-session">
            <dl>
              <dt>包标识</dt>
              <dd data-testid="upload-session-id">{session.packageId}</dd>
              <dt>对象 Key</dt>
              <dd data-testid="upload-session-object-key">{session.objectKey}（服务端生成）</dd>
              <dt>上传 URL 过期时间</dt>
              <dd>
                <TimeText iso={session.uploadUrlExpiresAt} />
                <span className="field-hint">（短期预签名，900s 暂定；过期需重建会话）</span>
              </dd>
            </dl>
            <label htmlFor="upload-file">选择与声明元数据匹配的固件文件</label>
            <input
              id="upload-file"
              type="file"
              data-testid="upload-file"
              onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className="primary-button"
              data-testid="upload-complete-submit"
              disabled={busy || uploadFile === null}
              onClick={() => void submitComplete()}
            >
              已完成直传，提交校验
            </button>
          </div>
        ) : null}

        {verified !== null ? (
          <p className="verified-result" role="status" data-testid="verified-result">
            {verified.model} {verified.version}（{PACKAGE_TYPE_LABELS[verified.packageType]}）：
            {PACKAGE_STATUS_LABELS[verified.status]}
          </p>
        ) : null}
      </section>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <Modal open={formOpen} title="新建固件上传会话" testid="upload-form" onClose={() => setFormOpen(false)}>
        <div className="dialog-field">
          <label htmlFor="upload-model">目标设备型号 model</label>
          <input
            id="upload-model"
            data-testid="upload-model"
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          />
          {fieldErrors.model !== undefined ? (
            <p className="field-hint" data-testid="upload-model-error">
              {fieldErrors.model}
            </p>
          ) : null}
        </div>
        <div className="dialog-field">
          <label htmlFor="upload-version">版本 version</label>
          <input
            id="upload-version"
            data-testid="upload-version"
            value={draft.version}
            onChange={(event) => setDraft({ ...draft, version: event.target.value })}
          />
          {fieldErrors.version !== undefined ? (
            <p className="field-hint" data-testid="upload-version-error">
              {fieldErrors.version}
            </p>
          ) : null}
        </div>
        <div className="dialog-field">
          <label htmlFor="upload-package-type">包类型 packageType（CT-03 枚举）</label>
          <select
            id="upload-package-type"
            data-testid="upload-package-type"
            value={draft.packageType}
            onChange={(event) => setDraft({ ...draft, packageType: event.target.value as FirmwarePackageType })}
          >
            {PACKAGE_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {PACKAGE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-field">
          <label htmlFor="upload-size">包大小 sizeBytes（字节，上限 512MiB={MAX_PACKAGE_SIZE_BYTES}）</label>
          <input
            id="upload-size"
            data-testid="upload-size"
            inputMode="numeric"
            value={draft.sizeBytes}
            onChange={(event) => setDraft({ ...draft, sizeBytes: event.target.value })}
          />
          {fieldErrors.sizeBytes !== undefined ? (
            <p className="field-hint" data-testid="upload-size-error">
              {fieldErrors.sizeBytes}
            </p>
          ) : null}
        </div>
        <div className="dialog-field">
          <label htmlFor="upload-sha256">SHA-256（64 位 hex；complete 时服务端重算比对）</label>
          <input
            id="upload-sha256"
            data-testid="upload-sha256"
            value={draft.sha256}
            onChange={(event) => setDraft({ ...draft, sha256: event.target.value })}
          />
          {fieldErrors.sha256 !== undefined ? (
            <p className="field-hint" data-testid="upload-sha256-error">
              {fieldErrors.sha256}
            </p>
          ) : null}
        </div>
        <div className="dialog-field">
          <label htmlFor="upload-signature">数字签名（对 model+version+packageType+sha256 规范载荷）</label>
          <textarea
            id="upload-signature"
            data-testid="upload-signature"
            value={draft.signature}
            onChange={(event) => setDraft({ ...draft, signature: event.target.value })}
          />
          {fieldErrors.signature !== undefined ? (
            <p className="field-hint" data-testid="upload-signature-error">
              {fieldErrors.signature}
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button"
            data-testid="upload-session-submit"
            disabled={busy || hasUploadErrors(fieldErrors)}
            onClick={() => void submitSession()}
          >
            创建上传会话
          </button>
        </div>
      </Modal>

      <section data-testid="package-list-section" aria-label="包列表">
        <h4>包列表</h4>
        <p className="field-hint">可发布列表 = status VERIFIED；UPLOADED（未完成上传/未完成校验）不进入可发布列表。</p>
        <div className="filter-bar">
          <label htmlFor="pkg-filter-model">型号</label>
          <input
            id="pkg-filter-model"
            data-testid="pkg-filter-model"
            value={draftFilter.model ?? ''}
            onChange={(event) => setDraftFilter({ ...draftFilter, model: event.target.value })}
          />
          <label htmlFor="pkg-filter-version">版本</label>
          <input
            id="pkg-filter-version"
            data-testid="pkg-filter-version"
            value={draftFilter.version ?? ''}
            onChange={(event) => setDraftFilter({ ...draftFilter, version: event.target.value })}
          />
          <label htmlFor="pkg-filter-type">类型</label>
          <select
            id="pkg-filter-type"
            data-testid="pkg-filter-type"
            value={draftFilter.packageType ?? ''}
            onChange={(event) =>
              setDraftFilter({
                ...draftFilter,
                packageType: event.target.value === '' ? null : (event.target.value as FirmwarePackageType),
              })
            }
          >
            <option value="">全部</option>
            {PACKAGE_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {PACKAGE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <label htmlFor="pkg-filter-status">状态</label>
          <select
            id="pkg-filter-status"
            data-testid="pkg-filter-status"
            value={draftFilter.status ?? ''}
            onChange={(event) =>
              setDraftFilter({
                ...draftFilter,
                status: event.target.value === '' ? null : (event.target.value as FirmwarePackageStatus),
              })
            }
          >
            <option value="">全部</option>
            {PACKAGE_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {PACKAGE_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="primary-button"
            data-testid="pkg-filter-search"
            onClick={() => onApplyFilter(draftFilter)}
          >
            筛选
          </button>
        </div>
        <CursorTable
          ariaLabel="固件包列表"
          columns={[
            { key: 'model', header: '型号', render: (p) => p.model },
            { key: 'version', header: '版本', render: (p) => p.version },
            { key: 'packageType', header: '类型', render: (p) => PACKAGE_TYPE_LABELS[p.packageType] },
            {
              key: 'status',
              header: '状态',
              render: (p) => (
                <>
                  {PACKAGE_STATUS_LABELS[p.status]}
                  {p.status === 'VERIFIED' ? (
                    <span className="verified-badge" data-testid={`publishable-${p.packageId}`}>
                      可发布
                    </span>
                  ) : null}
                </>
              ),
            },
            { key: 'sizeBytes', header: '大小', render: (p) => `${p.sizeBytes} B` },
            { key: 'sha256', header: 'SHA-256', render: (p) => <code>{p.sha256.slice(0, 16)}…</code> },
            { key: 'uploadedBy', header: '上传人', render: (p) => p.uploadedBy },
            { key: 'createdAt', header: '创建时间', render: (p) => <TimeText iso={p.createdAt} /> },
          ]}
          rows={packages.rows === null ? null : [...packages.rows]}
          rowKey={(p) => p.packageId}
          {...(packages.loading !== undefined ? { loading: packages.loading } : {})}
          {...(packages.error !== undefined ? { error: packages.error } : {})}
          {...(packages.nextCursor !== undefined ? { nextCursor: packages.nextCursor } : {})}
          onNextPage={onLoadMore}
          onRefresh={onRefresh}
          emptyText="暂无固件包"
        />
      </section>
    </div>
  );
}
