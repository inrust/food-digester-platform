import { Button } from './ui.js';
import { translate } from '../i18n/i18n.js';
/**
 * 通用异步导出面板（FE-11 ESG 导出 / FE-12 活动日志导出共享）：
 * 创建 → 状态刷新 → 短期下载 URL；过期链接明确提示且不渲染链接。
 */
import { TimeText } from './TimeText.js';
import { NumberText } from './LocaleValue.js';
/** 导出任务最小结构（ESG/活动日志导出视图均兼容）。 */
export interface ExportJobLike {
  readonly exportId: string;
  readonly status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  readonly rowCount: number | null;
  readonly downloadUrl: string | null;
  readonly urlExpiresAt: string | null;
  readonly urlExpired: boolean;
  readonly error: string | null;
}
export const EXPORT_STATUS_LABELS: Readonly<Record<string, string>> = {
  get PENDING() {
    return translate('ui.4dcbbcfa6154');
  },
  get PROCESSING() {
    return translate('ui.e30445a3369c');
  },
  get COMPLETED() {
    return translate('page.e99b48a29bdf');
  },
  get FAILED() {
    return translate('ui.3e3c8068bb0e');
  },
};
export function ExportPanel({
  testidPrefix,
  canExport,
  busy,
  job,
  onExport,
  onCheckStatus,
}: {
  readonly testidPrefix: string;
  readonly canExport: boolean;
  readonly busy: boolean;
  readonly job: ExportJobLike | null;
  readonly onExport: () => void;
  readonly onCheckStatus: (exportId: string) => void;
}) {
  return (
    <div className="export-panel" data-testid={`${testidPrefix}-export-panel`}>
      {canExport ? (
        <Button
          type="button"
          className="primary-button"
          data-testid={`${testidPrefix}-export-csv`}
          disabled={busy}
          onClick={onExport}
        >
          {translate('ui.4cb9bf63076d')}
        </Button>
      ) : null}
      {job !== null ? (
        <div className="export-job" data-testid={`${testidPrefix}-export-job`}>
          <span>
            {translate('ui.a79849e780d0') + ' '}
            {job.exportId}：{EXPORT_STATUS_LABELS[job.status] ?? job.status}
            {job.rowCount !== null ? (
              <>
                （<NumberText value={job.rowCount} /> {translate('ui.77941f4e0b9b')}）
              </>
            ) : null}
          </span>
          {job.status === 'PENDING' || job.status === 'PROCESSING' ? (
            <Button
              type="button"
              data-testid={`${testidPrefix}-export-refresh`}
              onClick={() => onCheckStatus(job.exportId)}
            >
              {translate('ui.7cc7f07a2c03')}
            </Button>
          ) : null}
          {job.status === 'COMPLETED' && job.urlExpired ? (
            <p className="export-expired" role="alert" data-testid={`${testidPrefix}-export-expired`}>
              {translate('ui.3d93b27b7781')}
            </p>
          ) : null}
          {job.status === 'COMPLETED' && !job.urlExpired && job.downloadUrl !== null ? (
            <a href={job.downloadUrl} data-testid={`${testidPrefix}-export-download`} download>
              {translate('ui.bc02f810f9e1')}
              {job.urlExpiresAt !== null ? (
                <>
                  {translate('ui.c30b529c0386') + ' '}
                  <TimeText iso={job.urlExpiresAt} />）
                </>
              ) : null}
            </a>
          ) : null}
          {job.status === 'FAILED' ? (
            <p className="error-notice" role="alert" data-testid={`${testidPrefix}-export-failed`}>
              {translate('ui.675338126127')}
              {job.error !== null ? `：${job.error}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
