// @vitest-environment jsdom
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  NumberText,
  PercentText,
  UnitValueText,
  formatLocaleNumber,
  formatLocalePercent,
  formatLocaleUnit,
} from '../src/components/LocaleValue.js';
import { formatInTimeZone } from '../src/components/TimeText.js';
import { I18nProvider } from '../src/i18n/i18n.js';

afterEach(cleanup);

test('统一 formatter 按 locale 输出数字、百分比和单位', () => {
  assert.equal(formatLocaleNumber(12345.6789, 'en'), '12,345.679');
  assert.equal(formatLocalePercent(12.34, 'en'), '12.3%');
  assert.match(formatLocaleUnit(12.5, 'kg', 'en'), /12\.5 kilograms/u);
  assert.match(formatLocaleUnit(12.5, 'kg', 'zh-CN'), /12\.5.*千克/u);
  assert.equal(formatLocaleUnit(7, 'protocol-unit', 'en'), '7 protocol-unit');
});

test('组件跟随当前语言，日期切换 locale 时保持所选时区', () => {
  const { unmount } = render(
    <I18nProvider initialLanguage="zh-CN">
      <span data-testid="values">
        <NumberText value={1234.5} />|<PercentText value={45} />|<UnitValueText value={2} unit="kg" />
      </span>
    </I18nProvider>,
  );
  assert.match(screen.getByTestId('values').textContent ?? '', /千克/u);
  unmount();
  render(
    <I18nProvider initialLanguage="en">
      <span data-testid="values">
        <NumberText value={1234.5} />|<PercentText value={45} />|<UnitValueText value={2} unit="kg" />
      </span>
    </I18nProvider>,
  );
  assert.match(screen.getByTestId('values').textContent ?? '', /kilograms/u);

  const iso = '2026-09-12T00:00:00Z';
  const zh = formatInTimeZone(iso, 'Asia/Shanghai', 'zh-CN');
  const en = formatInTimeZone(iso, 'Asia/Shanghai', 'en-US');
  assert.notEqual(zh, en);
  assert.match(zh, /08:00:00/u);
  assert.match(en, /08:00:00/u);
});
