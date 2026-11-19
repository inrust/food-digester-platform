import { translate } from '../i18n/i18n.js';
import { ErrorNotice } from './ErrorNotice.js';
import { ScopeFilter } from './ScopeFilter.js';
import type { ScopeFilterProps } from './ScopeFilter.js';
import type { ScopeFilterValue } from './filter-state.js';
import { Button } from './ui.js';

export type DevicePickerOptions = Pick<ScopeFilterProps, 'regions' | 'subregions' | 'sites'> & {
  readonly devices: NonNullable<ScopeFilterProps['devices']>;
};
export type DevicePickerState =
  { readonly status: 'loading' | 'ready' } | { readonly status: 'error'; readonly error: unknown };

export function DeviceScopePicker({
  options,
  state = { status: 'ready' },
  value,
  onChange,
  onApply,
  onRetry,
  actionLabel,
  actionId,
}: {
  readonly options: DevicePickerOptions;
  readonly state?: DevicePickerState;
  readonly value: ScopeFilterValue;
  readonly onChange: (next: ScopeFilterValue) => void;
  readonly onApply: (deviceId: string) => void;
  readonly onRetry?: () => void;
  readonly actionLabel: string;
  readonly actionId: string;
}) {
  const device = options.devices.find(({ value: id }) => id === value.deviceId);
  const canApply = state.status === 'ready' && device !== undefined;
  return (
    <div>
      <div className="filter-bar">
        <ScopeFilter {...options} allowDirectDevice value={value} onChange={onChange} />
        <Button
          type="button"
          className="primary-button"
          data-testid={actionId}
          aria-describedby={`${actionId}-hint`}
          disabled={!canApply}
          onClick={() => {
            if (canApply) onApply(device.value);
          }}
        >
          {actionLabel}
        </Button>
      </div>
      <div id={`${actionId}-hint`} className="field-hint" role="status">
        {state.status === 'loading'
          ? translate('devicePicker.loading')
          : state.status === 'ready' && options.devices.length === 0
            ? translate('devicePicker.empty')
            : translate('devicePicker.hint')}
      </div>
      {state.status === 'error' ? (
        <div data-testid="device-picker-error">
          <ErrorNotice error={state.error} />
          <Button type="button" onClick={onRetry}>
            {translate('devicePicker.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
