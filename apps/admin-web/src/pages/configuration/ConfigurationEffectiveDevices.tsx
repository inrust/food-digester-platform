import { useEffect, useState } from 'react';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { TimeText } from '../../components/TimeText.js';
import { Button } from '../../components/ui.js';
import { useI18n } from '../../i18n/i18n.js';
import type { ConfigurationEffectiveDevicePage } from './types.js';

interface DevicePageQuery {
  readonly cursor: string | null;
  readonly previous: readonly (string | null)[];
}

export function ConfigurationEffectiveDevices({
  configurationId,
  onLoadPage,
  refreshing,
}: {
  readonly configurationId: string;
  readonly onLoadPage: (configurationId: string, cursor: string | null) => Promise<ConfigurationEffectiveDevicePage>;
  readonly refreshing: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState<DevicePageQuery | null>(null);
  const [result, setResult] = useState<{
    readonly query: DevicePageQuery;
    readonly page?: ConfigurationEffectiveDevicePage;
    readonly error?: unknown;
  } | null>(null);

  useEffect(() => {
    if (query === null || refreshing) return;
    let active = true;
    void onLoadPage(configurationId, query.cursor).then(
      (page) => {
        if (active) setResult({ query, page });
      },
      (error: unknown) => {
        if (active) setResult({ query, error });
      },
    );
    return () => {
      active = false;
    };
  }, [configurationId, onLoadPage, query, refreshing]);

  const current = result?.query === query ? result : null;
  const loading = query !== null && (current === null || refreshing);
  const page = loading ? undefined : current?.page;
  const title = t('configuration.devices.title');
  return (
    <section className="detail-card" aria-label={title}>
      <h4>{title}</h4>
      <p className="field-hint">{t('configuration.devices.explanation')}</p>
      <Button
        type="button"
        data-testid="config-devices-load"
        disabled={loading || refreshing}
        onClick={() => setQuery(query === null ? { cursor: null, previous: [] } : { ...query })}
      >
        {t(query === null ? 'configuration.devices.load' : 'common.refresh')}
      </Button>
      {query === null ? null : loading ? (
        <p role="status">{t('common.loading')}</p>
      ) : page === undefined ? (
        <ErrorNotice error={current?.error} />
      ) : (
        <>
          <p className="field-hint">
            {t('configuration.devices.evaluatedAt')} <TimeText iso={page.timestamp} />
          </p>
          <CursorTable
            ariaLabel={title}
            keyboardScrollable
            rows={page.rows}
            rowKey={(device) => device.deviceId}
            nextCursor={page.nextCursor}
            hasPrevPage={query.previous.length > 0}
            onNextPage={(cursor) => setQuery({ cursor, previous: [...query.previous, query.cursor] })}
            onPrevPage={() =>
              setQuery({ cursor: query.previous.at(-1) ?? null, previous: query.previous.slice(0, -1) })
            }
            emptyText={t('configuration.devices.empty')}
            columns={[
              {
                key: 'device',
                header: t('configuration.devices.device'),
                render: (device) => (
                  <>
                    <strong>{device.alias ?? device.serialNumber}</strong>
                    <div>{device.deviceId}</div>
                    <div>{device.model}</div>
                  </>
                ),
              },
              {
                key: 'cloud',
                header: t('configuration.devices.cloud'),
                render: ({ cloudEffectiveConfiguration: effective }) =>
                  effective === null ? (
                    t('configuration.devices.noEffective')
                  ) : (
                    <>
                      <strong>
                        {effective.name} · v{effective.version}
                      </strong>
                      <div>{effective.configurationId}</div>
                      <div>
                        {t(
                          effective.source === 'DEVICE'
                            ? 'configuration.devices.sourceDevice'
                            : 'configuration.devices.sourceModel',
                        )}
                      </div>
                      <TimeText iso={effective.effectiveAt} />
                    </>
                  ),
              },
              {
                key: 'applied',
                header: t('configuration.devices.applied'),
                render: () => t('configuration.devices.unknown'),
              },
            ]}
          />
        </>
      )}
    </section>
  );
}
