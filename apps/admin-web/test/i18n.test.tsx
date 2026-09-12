// @vitest-environment jsdom
/**
 * FE-19 双语言切换测试：
 * - en/zh-CN key 集 parity（缺失 key 检测为 0）+ 非空；
 * - 错误码统一映射两种语言均有明确提示；requestId 原文保留；服务端 message 原文展示；
 * - 语言切换即时更新（菜单/面包屑/共享组件）+ localStorage 持久化 + <html lang>；
 * - 刷新/重新登录保持（重新挂载读取持久化值）；
 * - 日期按语言区域格式化（时间仍按用户时区）；
 * - 已迁移文件硬编码中文残留扫描 = 0（缺失文案/硬编码检测脚本）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, assert, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ApiClientError } from '../src/api/errors.js';
import { CursorTable } from '../src/components/CursorTable.js';
import { ErrorNotice } from '../src/components/ErrorNotice.js';
import { formatInTimeZone, TimeZoneProvider } from '../src/components/TimeText.js';
import { I18nProvider, LANGUAGE_OPTIONS, LANGUAGE_STORAGE_KEY, localeForLanguage } from '../src/i18n/i18n.js';
import { ZH_CN } from '../src/i18n/resources/zh-CN.js';
import { EN } from '../src/i18n/resources/en.js';
import { AppShell } from '../src/shell/AppShell.js';
import type { SessionSnapshot } from '../src/session/session-manager.js';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SESSION: SessionSnapshot = { username: 'zhang@example.com', roles: ['PlatformSuperAdmin'], customerId: null };

function renderApp(language?: 'zh-CN' | 'en') {
  return render(
    <I18nProvider {...(language !== undefined ? { initialLanguage: language } : {})}>
      <TimeZoneProvider>
        <AppShell path="/dashboard" session={SESSION} onNavigate={() => {}} onLogout={() => {}}>
          <CursorTable ariaLabel="示例" columns={[]} rows={[]} rowKey={() => 'x'} />
        </AppShell>
      </TimeZoneProvider>
    </I18nProvider>,
  );
}

// ---------- 缺失文案检测（key parity = 0 缺失） ----------

test('语言资源 key 集完全一致（缺失 0）且全部非空；仅 en/zh-CN 两种语言', () => {
  assert.deepEqual([...LANGUAGE_OPTIONS], ['zh-CN', 'en']);
  const zhKeys = Object.keys(ZH_CN).sort();
  const enKeys = Object.keys(EN).sort();
  assert.deepEqual(enKeys, zhKeys, 'en/zh-CN key 集不一致');
  for (const [key, value] of Object.entries(ZH_CN)) {
    assert.ok(value.trim().length > 0, `zh-CN ${key} 为空`);
  }
  for (const [key, value] of Object.entries(EN)) {
    assert.ok(value.trim().length > 0, `en ${key} 为空`);
    assert.equal(CJK_PATTERN.test(value), false, `en ${key} 仍含中文`);
  }
});

test('错误码统一映射：两类语言均有明确提示', () => {
  for (const code of [
    'FORBIDDEN',
    'UNAUTHENTICATED',
    'NOT_FOUND',
    'VERSION_CONFLICT',
    'CONFLICT',
    'VALIDATION_FAILED',
    'INTERNAL_ERROR',
  ]) {
    assert.ok(ZH_CN[`error.code.${code}`] !== undefined, `zh-CN 缺 error.code.${code}`);
    assert.ok(EN[`error.code.${code}`] !== undefined, `en 缺 error.code.${code}`);
  }
});

// ---------- 切换即时更新 + 持久化 ----------

test('切换语言：菜单/面包屑/共享组件文案即时完整更新；localStorage 与 <html lang> 同步', async () => {
  const user = userEvent.setup();
  renderApp('zh-CN');
  assert.ok(screen.getByRole('link', { name: '概览' }));
  assert.ok(screen.getByRole('button', { name: '登出' }));
  assert.ok(screen.getByTestId('table-empty').textContent?.includes('暂无数据'));

  await user.selectOptions(screen.getByTestId('language-select'), 'en');
  // 即时更新
  assert.ok(screen.getByRole('link', { name: 'Overview' }));
  assert.ok(screen.getByRole('button', { name: 'Sign Out' }));
  assert.ok(screen.getByTestId('table-empty').textContent?.includes('No data'));
  assert.equal(screen.queryByRole('link', { name: '概览' }), null);
  // 持久化 + lang 属性
  assert.equal(window.localStorage.getItem(LANGUAGE_STORAGE_KEY), 'en');
  assert.equal(document.documentElement.lang, 'en');
});

test('刷新/重新登录后语言保持：重新挂载读取持久化值', () => {
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'en');
  renderApp();
  assert.ok(screen.getByRole('link', { name: 'Overview' }));
  // 非法持久化值回退 zh-CN
  cleanup();
  window.localStorage.setItem(LANGUAGE_STORAGE_KEY, 'fr');
  renderApp();
  assert.ok(screen.getByRole('link', { name: '概览' }));
});

// ---------- 错误映射与 requestId ----------

test('英文下错误提示翻译；requestId 与服务端 message 原文保留', () => {
  render(
    <I18nProvider initialLanguage="en">
      <ErrorNotice error={new ApiClientError(403, 'FORBIDDEN', 'denied', 'req-9')} />
      <ErrorNotice error={new ApiClientError(500, 'INTERNAL_ERROR', 'boom-raw-message', 'req-10')} />
    </I18nProvider>,
  );
  const forbidden = screen.getByTestId('error-forbidden');
  assert.ok(forbidden.textContent?.includes('Access Denied'));
  assert.ok(forbidden.textContent?.includes('requestId：req-9'));
  const generic = screen.getByTestId('error-generic');
  assert.ok(generic.textContent?.includes('boom-raw-message'));
  assert.ok(generic.textContent?.includes('requestId：req-10'));
});

// ---------- 日期区域格式化 ----------

test('日期按语言区域格式化（时间仍按用户时区）', () => {
  const iso = '2026-09-06T04:00:00Z';
  const zh = formatInTimeZone(iso, 'Asia/Shanghai', localeForLanguage('zh-CN'));
  const en = formatInTimeZone(iso, 'Asia/Shanghai', localeForLanguage('en'));
  assert.equal(
    zh,
    new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso)),
  );
  assert.equal(
    en,
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(iso)),
  );
  assert.notEqual(zh, en);
  // 非法输入安全回退
  assert.equal(formatInTimeZone('garbage'), '—');
});

// ---------- 全量 UI 源码硬编码中文残留扫描 ----------

const CJK_PATTERN = /[㐀-鿿豈-﫿]/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function uiSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'resources' ? [] : uiSourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path.slice(ROOT.length + 1)] : [];
  });
}

test('全部 24 个页面及全量 UI 源码无硬编码中文文案（仅保留语言原生名称）', () => {
  const violations: string[] = [];
  const pageModules = uiSourceFiles(resolve(ROOT, 'src/pages')).filter((file) => file.endsWith('.tsx'));
  assert.equal(pageModules.length, 24, '页面扫描范围必须覆盖 24 个 TSX 模块');
  for (const file of uiSourceFiles(resolve(ROOT, 'src'))) {
    const source = stripComments(readFileSync(resolve(ROOT, file), 'utf8'));
    const lines = source.split('\n');
    for (const [index, line] of lines.entries()) {
      // 窄白名单：语言选择器必须以该语言的原生名称展示。
      if (file === 'src/i18n/i18n.tsx' && line.includes("'zh-CN': '简体中文'")) continue;
      if (CJK_PATTERN.test(line)) {
        violations.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(violations, [], '存在硬编码中文文案');
});
