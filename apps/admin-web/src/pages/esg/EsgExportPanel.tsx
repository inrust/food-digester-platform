/**
 * FE-11 ESG 导出面板（两页共享）：创建异步导出 → 状态轮询 → 短期下载 URL。
 * 过期下载链接有明确提示（urlExpired → 不渲染链接，提示重新导出）。
 */
import { TimeText } from '../../components/TimeText.js';
import { EXPORT_STATUS_LABELS } from './esg-state.js';
import type { EsgExportJobView } from './types.js';

export function EsgExportPanel({
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
  readonly job: EsgExportJobView | null;
  readonly onExport: () => void;
  readonly onCheckStatus: (exportId: string) => void;
}) {
  return (
    <div className="export-panel" data-testid={`${testidPrefix}-export-panel`}>
      {canExport ? (
        <button
          type="button"
          className="primary-button"
          data-testid={`${testidPrefix}-export-csv`}
          disabled={busy}
          onClick={onExport}
        >
          导出CSV文件
        </button>
      ) : null}
      {job !== null ? (
        <div className="export-job" data-testid={`${testidPrefix}-export-job`}>
          <span>
            导出任务 {job.exportId}：{EXPORT_STATUS_LABELS[job.status] ?? job.status}
            {job.rowCount !== null ? `（${job.rowCount} 行）` : ''}
          </span>
          {job.status === 'PENDING' || job.status === 'PROCESSING' ? (
            <button type="button" data-testid={`${testidPrefix}-export-refresh`} onClick={() => onCheckStatus(job.exportId)}>
              刷新状态
            </button>
          ) : null}
          {job.status === 'COMPLETED' && job.urlExpired ? (
            <p className="export-expired" role="alert" data-testid={`${testidPrefix}-export-expired`}>
              下载链接已过期（短期有效），请重新导出。
            </p>
          ) : null}
          {job.status === 'COMPLETED' && !job.urlExpired && job.downloadUrl !== null ? (
            <a href={job.downloadUrl} data-testid={`${testidPrefix}-export-download`} download>
              下载 CSV
              {job.urlExpiresAt !== null ? (
                <>
                  （链接有效期至 <TimeText iso={job.urlExpiresAt} />）
                </>
              ) : null}
            </a>
          ) : null}
          {job.status === 'FAILED' ? (
            <p className="error-notice" role="alert" data-testid={`${testidPrefix}-export-failed`}>
              导出失败{job.error !== null ? `：${job.error}` : ''}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
