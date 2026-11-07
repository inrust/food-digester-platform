import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/http-client.js';
import { Button } from '../../components/ui.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { TimeText } from '../../components/TimeText.js';
import { useI18n } from '../../i18n/i18n.js';
import { startImagePreview } from './live-image-session.js';
import type { ImagePreviewState } from './live-image-session.js';

function PreviewInstance({
  api,
  deviceId,
  label,
}: {
  readonly api: ApiClient;
  readonly deviceId: string;
  readonly label: string;
}) {
  const { t } = useI18n();
  const stopRef = useRef<(() => void) | undefined>(undefined);
  const [open, setOpen] = useState(false),
    [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  const [attempt, setAttempt] = useState(0),
    [state, setState] = useState<ImagePreviewState>({ status: 'connecting' });
  useEffect(() => {
    const hide = () => {
      stopRef.current?.();
      setState({ status: 'connecting' });
      setVisible(false);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') hide();
      else setVisible(true);
    };
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', hide);
    window.addEventListener('pageshow', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', hide);
      window.removeEventListener('pageshow', visibility);
    };
  }, []);
  useEffect(() => {
    if (!open || !visible) return;
    const stop = startImagePreview({ api, deviceId, onState: setState });
    stopRef.current = stop;
    return () => {
      stop();
      if (stopRef.current === stop) stopRef.current = undefined;
    };
  }, [api, deviceId, open, visible, attempt]);
  const status = !open ? 'closed' : !visible ? 'paused' : state.status;
  return (
    <section className="live-image-preview" data-testid="live-image-preview" aria-label={t('liveImage.title')}>
      <header className="live-image-heading">
        <div>
          <h3>{t('liveImage.title')}</h3>
          <p>
            {label} · {t('liveImage.description')}
          </p>
        </div>
        <Button
          onClick={() => {
            stopRef.current?.();
            setState({ status: 'connecting' });
            setOpen((value) => !value);
          }}
          data-testid="live-image-toggle"
        >
          {t(open ? 'liveImage.close' : 'liveImage.open')}
        </Button>
      </header>
      {open ? (
        <>
          <p role="status" className="live-image-status">
            {t(`liveImage.${status}`)}
          </p>
          <div className="live-image-stage">
            {visible && state.status === 'ready' ? (
              <img
                src={`data:image/jpeg;base64,${state.frame.imageBase64}`}
                onError={() => {
                  stopRef.current?.();
                  setState({ status: 'error', error: new Error('IMAGE_DECODE_FAILED') });
                }}
                alt={t('liveImage.alt', { device: label })}
                data-testid="live-image-frame"
              />
            ) : (
              <p>{t(`liveImage.${status}`)}</p>
            )}
          </div>
          {visible && state.status === 'ready' ? (
            <p>
              {t('liveImage.captured')} <TimeText iso={state.frame.capturedAt} />
            </p>
          ) : null}
          {visible && state.status === 'error' ? (
            <>
              <ErrorNotice error={state.error} />
              <Button
                onClick={() => {
                  setState({ status: 'connecting' });
                  setAttempt((value) => value + 1);
                }}
              >
                {t('liveImage.retry')}
              </Button>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

export function LiveImagePreview(props: {
  readonly api: ApiClient;
  readonly deviceId: string;
  readonly label: string;
}) {
  return <PreviewInstance key={props.deviceId} {...props} />;
}
