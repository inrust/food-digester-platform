import { translate } from '../../i18n/i18n.js';
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
const EMPTY_DRAFT: UploadMetadataDraft & {
  packageType: FirmwarePackageType;
} = {
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
      setNotice(translate('page.81cb6f9c1a9e') + created.packageId + translate('page.2a990bdd005a'));
    });
  const submitComplete = () =>
    runAction(async () => {
      if (session === null || uploadFile === null) return;
      const pkg = await onUploadAndComplete(session, uploadFile);
      setVerified(pkg);
      setSession(null);
      setNotice(
        pkg.status === 'VERIFIED'
          ? translate('page.2b398be8d2e2') + ' ' + pkg.packageId + (' ' + translate('page.b7259b8a3482'))
          : translate('page.4565ac471fb6') + PACKAGE_STATUS_LABELS[pkg.status],
      );
      onRefresh();
    });
  return (
    <div className="ota-packages-page" data-testid="ota-packages-page">
      <div className="page-header">
        <h3>{translate('page.520fc0679572')}</h3>
        <button type="button" data-testid="goto-ota-campaigns" onClick={() => onNavigate('/ota/campaigns')}>
          {translate('page.3a40dc3045ce')}
        </button>
      </div>

      <section data-testid="package-upload" aria-label={translate('page.63395c3e01ec')}>
        <h4>{translate('page.63395c3e01ec')}</h4>
        <p className="field-hint">{translate('page.719057e1cc5e')}</p>
        <button
          type="button"
          className="primary-button"
          data-testid="upload-session-open"
          disabled={!canWrite || busy}
          {...(!canWrite ? { title: translate('page.89dc6cfd462e') } : {})}
          onClick={() => {
            setDraft(EMPTY_DRAFT);
            setSession(null);
            setVerified(null);
            setActionError(null);
            setFormOpen(true);
          }}
        >
          {translate('page.4989a23c850b')}
        </button>
        {!canWrite ? (
          <span className="deny-reason" data-testid="upload-deny">
            {translate('page.89dc6cfd462e')}
          </span>
        ) : null}

        {session !== null ? (
          <div className="upload-session" data-testid="upload-session">
            <dl>
              <dt>{translate('page.242d7f2bc2dc')}</dt>
              <dd data-testid="upload-session-id">{session.packageId}</dd>
              <dt>{translate('page.723e28ff9711')}</dt>
              <dd data-testid="upload-session-object-key">
                {session.objectKey}
                {translate('page.1a14ac10df4f')}
              </dd>
              <dt>{translate('page.cac6db32682b')}</dt>
              <dd>
                <TimeText iso={session.uploadUrlExpiresAt} />
                <span className="field-hint">{translate('page.7da626867c1a')}</span>
              </dd>
            </dl>
            <label htmlFor="upload-file">{translate('page.2f8765ba1a63')}</label>
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
              {translate('page.04b4e141a193')}
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

      <Modal
        open={formOpen}
        title={translate('page.a285f7b5c29d')}
        testid="upload-form"
        onClose={() => setFormOpen(false)}
      >
        <div className="dialog-field">
          <label htmlFor="upload-model">{translate('page.51bc54c99631')}</label>
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
          <label htmlFor="upload-version">{translate('page.85c5eb624c9b')}</label>
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
          <label htmlFor="upload-package-type">{translate('page.2ccb8faceb30')}</label>
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
          <label htmlFor="upload-size">
            {translate('page.39ebdcfde88f')}
            {MAX_PACKAGE_SIZE_BYTES}）
          </label>
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
          <label htmlFor="upload-sha256">{translate('page.3011c1372cd5')}</label>
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
          <label htmlFor="upload-signature">{translate('page.4433ede01c71')}</label>
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
            {translate('page.b432cfd5e434')}
          </button>
        </div>
      </Modal>

      <section data-testid="package-list-section" aria-label={translate('page.89432be06ed2')}>
        <h4>{translate('page.89432be06ed2')}</h4>
        <p className="field-hint">{translate('page.c647d5faaad0')}</p>
        <div className="filter-bar">
          <label htmlFor="pkg-filter-model">{translate('page.0132ce7298ec')}</label>
          <input
            id="pkg-filter-model"
            data-testid="pkg-filter-model"
            value={draftFilter.model ?? ''}
            onChange={(event) => setDraftFilter({ ...draftFilter, model: event.target.value })}
          />
          <label htmlFor="pkg-filter-version">{translate('page.989d1affa089')}</label>
          <input
            id="pkg-filter-version"
            data-testid="pkg-filter-version"
            value={draftFilter.version ?? ''}
            onChange={(event) => setDraftFilter({ ...draftFilter, version: event.target.value })}
          />
          <label htmlFor="pkg-filter-type">{translate('page.e4e46c7235d1')}</label>
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
            <option value="">{translate('page.778fc8f99453')}</option>
            {PACKAGE_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {PACKAGE_TYPE_LABELS[type]}
              </option>
            ))}
          </select>
          <label htmlFor="pkg-filter-status">{translate('page.62e951a692ff')}</label>
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
            <option value="">{translate('page.778fc8f99453')}</option>
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
            {translate('page.dcce9a144a40')}
          </button>
        </div>
        <CursorTable
          ariaLabel={translate('page.2a076b4dcce7')}
          columns={[
            { key: 'model', header: translate('page.0132ce7298ec'), render: (p) => p.model },
            { key: 'version', header: translate('page.989d1affa089'), render: (p) => p.version },
            {
              key: 'packageType',
              header: translate('page.e4e46c7235d1'),
              render: (p) => PACKAGE_TYPE_LABELS[p.packageType],
            },
            {
              key: 'status',
              header: translate('page.62e951a692ff'),
              render: (p) => (
                <>
                  {PACKAGE_STATUS_LABELS[p.status]}
                  {p.status === 'VERIFIED' ? (
                    <span className="verified-badge" data-testid={`publishable-${p.packageId}`}>
                      {translate('page.461a47d26851')}
                    </span>
                  ) : null}
                </>
              ),
            },
            { key: 'sizeBytes', header: translate('page.fd20702c73d1'), render: (p) => `${p.sizeBytes} B` },
            { key: 'sha256', header: 'SHA-256', render: (p) => <code>{p.sha256.slice(0, 16)}…</code> },
            { key: 'uploadedBy', header: translate('page.135298390b58'), render: (p) => p.uploadedBy },
            { key: 'createdAt', header: translate('page.84e3802f60a7'), render: (p) => <TimeText iso={p.createdAt} /> },
          ]}
          rows={packages.rows === null ? null : [...packages.rows]}
          rowKey={(p) => p.packageId}
          {...(packages.loading !== undefined ? { loading: packages.loading } : {})}
          {...(packages.error !== undefined ? { error: packages.error } : {})}
          {...(packages.nextCursor !== undefined ? { nextCursor: packages.nextCursor } : {})}
          onNextPage={onLoadMore}
          onRefresh={onRefresh}
          emptyText={translate('page.4be8aa1aaf02')}
        />
      </section>
    </div>
  );
}
