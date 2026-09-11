/**
 * FE-19 i18n 框架：英文（en）/简体中文（zh-CN）双语言。
 *
 * - 缺省语言 zh-CN；缺省 Context 即 zh-CN（未挂 Provider 的旧测试/调用方行为不变）；
 * - 持久化：localStorage（刷新/重新登录后保持）；切换即时生效并同步 <html lang>；
 * - 缺失 key：运行时 console.warn 并回退 zh-CN → key（测试以 key parity 锁定缺失为 0）；
 * - 纪律：仅 UI 文案入资源；协议枚举原文、角色冻结显示名（DEC-012）、后端业务数据不翻译；
 *   requestId 原文保留；新增页面/字段须两套语言同步补齐（parity 检测）。
 */
import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ZH_CN } from './resources/zh-CN.js';
import { EN } from './resources/en.js';

export const LANGUAGE_OPTIONS = ['zh-CN', 'en'] as const;
export type Language = (typeof LANGUAGE_OPTIONS)[number];

export const LANGUAGE_LABELS: Readonly<Record<Language, string>> = {
  'zh-CN': '简体中文',
  en: 'English',
};

export const LANGUAGE_STORAGE_KEY = 'fdp.admin.lang.v1';

const RESOURCES: Readonly<Record<Language, Readonly<Record<string, string>>>> = {
  'zh-CN': ZH_CN,
  en: EN,
};

export function isLanguage(value: string): value is Language {
  return (LANGUAGE_OPTIONS as readonly string[]).includes(value);
}

/** 日期/数字区域格式化 locale（时间仍按用户时区显示）。 */
export function localeForLanguage(language: Language): string {
  return language === 'en' ? 'en-US' : 'zh-CN';
}

export type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

function makeTranslate(language: Language): Translate {
  return (key, params) => {
    let text: string | undefined = RESOURCES[language][key];
    if (text === undefined) {
      console.warn(`[i18n] missing key: ${key} (${language})`);
      text = RESOURCES['zh-CN'][key] ?? key;
    }
    if (params !== undefined) {
      for (const [name, value] of Object.entries(params)) {
        text = text.replaceAll(`{${name}}`, String(value));
      }
    }
    return text;
  };
}

export interface I18nValue {
  readonly language: Language;
  readonly setLanguage: (value: Language) => void;
  readonly t: Translate;
}

const DEFAULT_VALUE: I18nValue = {
  language: 'zh-CN',
  setLanguage: () => undefined,
  t: makeTranslate('zh-CN'),
};

const I18nContext = createContext<I18nValue>(DEFAULT_VALUE);

export interface I18nProviderProps {
  readonly children: ReactNode;
  /** 显式初始语言（测试）；缺省读 localStorage，再缺省 zh-CN。 */
  readonly initialLanguage?: Language;
}

export function I18nProvider({ children, initialLanguage }: I18nProviderProps) {
  const [language, setLanguageState] = useState<Language>(() => {
    if (initialLanguage !== undefined) return initialLanguage;
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return stored !== null && isLanguage(stored) ? stored : 'zh-CN';
  });

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = (value: Language) => {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, value);
    setLanguageState(value);
  };

  return (
    <I18nContext.Provider value={{ language, setLanguage, t: makeTranslate(language) }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** 菜单项资源 key（按 pageState）。 */
export function menuKeyForPageState(pageState: string): string {
  return `menu.${pageState}`;
}

/** 菜单分组资源 key。 */
export function menuKeyForGroup(groupId: string): string {
  return `menu.group.${groupId}`;
}
