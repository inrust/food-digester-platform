import { ConfigProvider } from 'antd';
import type { ConfigProviderProps } from 'antd';
import enUS from 'antd/locale/en_US.js';
import zhCN from 'antd/locale/zh_CN.js';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n/i18n.js';

export function DesignProvider({ children }: { children: ReactNode }) {
  const { language } = useI18n();
  return (
    <ConfigProvider
      locale={(language === 'zh-CN' ? zhCN : enUS) as unknown as NonNullable<ConfigProviderProps['locale']>}
      theme={{
        token: {
          colorPrimary: '#087f73',
          colorInfo: '#087f73',
          colorSuccess: '#16845b',
          colorWarning: '#b76b08',
          colorError: '#c43838',
          colorText: '#213547',
          colorTextSecondary: '#607184',
          colorBorder: '#d7e0e7',
          colorBgLayout: '#f3f6f9',
          borderRadius: 8,
          controlHeight: 36,
          fontSize: 14,
          fontFamily:
            'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: { headerBg: '#f6f8fa', headerColor: '#526579', cellPaddingBlock: 14, cellPaddingInline: 16 },
          Button: { fontWeight: 500, primaryShadow: '0 2px 4px rgb(8 127 115 / 16%)' },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
