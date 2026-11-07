import { useEffect, useRef, useState } from 'react';
import type { EvidenceImage } from '@fdp/contracts/rest/image-types.js';
import type { MediaDownloadUrlView } from '../media/types.js';
import { ApiClientError, UnauthenticatedError } from '../../api/errors.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { Button } from '../../components/ui.js';
import { useI18n } from '../../i18n/i18n.js';

export type EvidenceDownloadRequest = (id: string, signal?: AbortSignal) => Promise<MediaDownloadUrlView>;
type Props = {
  readonly sourceId: string;
  readonly evidence: EvidenceImage | null | undefined;
  readonly canRead: boolean;
  readonly requestUrl?: EvidenceDownloadRequest;
};
type DownloadState =
  | { status: 'idle' | 'loading' | 'expired' }
  | { status: 'ready'; download: MediaDownloadUrlView }
  | { status: 'error'; reason: 'forbidden' | 'unavailable' | 'failed' | 'imageFailed' | 'unauthenticated' };

/** The identity key discards signed URLs and pending replies on source/permission/association changes. */
export function EvidenceImageEntry(props: Props) {
  return (
    <EvidenceInstance
      key={`${props.sourceId}:${props.canRead}:${props.evidence?.mediaId}:${props.evidence?.status}:${props.evidence?.captureTime}`}
      {...props}
    />
  );
}
function EvidenceInstance({ sourceId, evidence, canRead, requestUrl }: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false),
    [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<DownloadState>({ status: 'idle' });
  const requestRef = useRef<AbortController | null>(null);
  const mediaId = evidence?.mediaId,
    status = evidence?.status;
  useEffect(() => {
    if (!open || !canRead || status !== 'AVAILABLE' || !mediaId || !requestUrl) return;
    const abort = new AbortController();
    requestRef.current = abort;
    let active = true,
      timedOut = false;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const watchdog = setTimeout(() => {
      timedOut = true;
      abort.abort(new Error('TIMEOUT'));
    }, 12000);
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort.signal.addEventListener('abort', () => reject(abort.signal.reason), { once: true });
    });
    void Promise.race([
      Promise.resolve().then(() => {
        abort.signal.throwIfAborted();
        return requestUrl(mediaId, abort.signal);
      }),
      cancelled,
    ])
      .then((download) => {
        if (!active || abort.signal.aborted) return;
        const url = new URL(download.downloadUrl);
        const ttl = Math.min(Date.parse(download.downloadUrlExpiresAt) - Date.now(), 900000);
        if (
          download.mediaId !== mediaId ||
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          !Number.isFinite(ttl)
        )
          throw new Error('INVALID_DOWNLOAD');
        if (ttl <= 0) {
          setState({ status: 'expired' });
          return;
        }
        setState({ status: 'ready', download });
        expiry = setTimeout(() => {
          if (active) setState((old) => (old.status === 'ready' ? { status: 'expired' } : old));
        }, ttl);
      })
      .catch((error: unknown) => {
        if (!active || (abort.signal.aborted && !timedOut)) return;
        const reason =
          error instanceof UnauthenticatedError || (error instanceof ApiClientError && error.status === 401)
            ? 'unauthenticated'
            : error instanceof ApiClientError && error.status === 403
              ? 'forbidden'
              : error instanceof ApiClientError && error.status === 404
                ? 'unavailable'
                : 'failed';
        setState({ status: 'error', reason });
      })
      .finally(() => clearTimeout(watchdog));
    return () => {
      active = false;
      clearTimeout(watchdog);
      clearTimeout(expiry);
      abort.abort();
      if (requestRef.current === abort) requestRef.current = null;
    };
  }, [open, attempt, canRead, mediaId, status, requestUrl]);
  const close = () => {
    requestRef.current?.abort();
    setOpen(false);
    setState({ status: 'idle' });
  };
  const request = () => {
    setState({ status: 'loading' });
    setAttempt((value) => value + 1);
    setOpen(true);
  };
  const retryable =
    state.status === 'expired' ||
    (state.status === 'error' && (state.reason === 'failed' || state.reason === 'imageFailed'));
  const unavailable = !canRead
    ? 'noPermission'
    : evidence === undefined
      ? 'notProvided'
      : evidence === null
        ? 'unlinked'
        : evidence.status === 'DELETED'
          ? 'deleted'
          : evidence.status !== 'AVAILABLE' || !requestUrl
            ? 'notProvided'
            : null;
  return (
    <div className="evidence-image-entry" data-testid={`evidence-${sourceId}`}>
      {unavailable ? (
        <span data-testid={`evidence-${unavailable}`}>{t(`evidence.${unavailable}`)}</span>
      ) : (
        <>
          <Button type="button" onClick={request} data-testid={`evidence-open-${sourceId}`}>
            {t('evidence.open')}
          </Button>
          {evidence ? (
            <span className="field-hint">
              {t('evidence.captured')} <TimeText iso={evidence.captureTime} />
            </span>
          ) : null}
        </>
      )}
      <Modal open={open && unavailable === null} title={t('evidence.title')} onClose={close} testid="evidence-modal">
        <Button type="button" onClick={close}>
          {t('evidence.close')}
        </Button>
        {state.status === 'loading' ? <p role="status">{t('evidence.loading')}</p> : null}
        {state.status === 'expired' ? <p role="status">{t('evidence.expired')}</p> : null}
        {state.status === 'error' ? <p role="alert">{t(`evidence.${state.reason}`)}</p> : null}
        {retryable ? (
          <Button type="button" onClick={request}>
            {t('evidence.retry')}
          </Button>
        ) : null}
        {state.status === 'ready' ? (
          <div className="evidence-image-content">
            <img
              src={state.download.downloadUrl}
              alt={t('evidence.alt')}
              referrerPolicy="no-referrer"
              data-testid="evidence-image"
              onError={() => setState({ status: 'error', reason: 'imageFailed' })}
            />
            <p>
              {t('evidence.expires')} <TimeText iso={state.download.downloadUrlExpiresAt} />
            </p>
            <a href={state.download.downloadUrl} download="evidence.jpg" rel="noreferrer" referrerPolicy="no-referrer">
              {t('evidence.download')}
            </a>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
