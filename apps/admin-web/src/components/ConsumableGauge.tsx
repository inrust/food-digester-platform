/**
 * FE-03 耗材展示（DEC-008：unknown 不画正常进度条；stale 标记；低于冻结阈值 warn）。
 * 复用方：总览设备卡片；FE-18 耗材页可复用。
 */
import type { ConsumableDisplayModel } from '../pages/dashboard/dashboard-state.js';

export function ConsumableGauge({ model }: { model: ConsumableDisplayModel }) {
  return (
    <div className="consumable" data-testid={`consumable-${model.consumableType}`}>
      <span className="consumable-name">{model.name}</span>
      {model.percent === null ? (
        <span className="consumable-value" data-testid={`consumable-value-${model.consumableType}`}>
          —
        </span>
      ) : (
        <>
          <div
            className="bar"
            role="progressbar"
            aria-valuenow={model.percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`${model.name}剩余`}
          >
            <div className={`fill${model.low ? ' warn' : ''}`} style={{ width: `${model.percent}%` }} />
          </div>
          <span className="consumable-value" data-testid={`consumable-value-${model.consumableType}`}>
            {model.percent}%
          </span>
        </>
      )}
      {model.stale ? (
        <span className="stale-tag" data-testid={`consumable-stale-${model.consumableType}`}>
          数据过期
        </span>
      ) : null}
    </div>
  );
}
