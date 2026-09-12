import { PAGE_ZH_CN } from './pages.js';

/**
 * FE-19 zh-CN 语言资源（缺省语言；与 en 资源 key 集 parity 锁定，缺失检测为 0）。
 *
 * 范围：壳层（菜单/面包屑/顶部栏）+ 共享组件（表格/确认框/错误提示/时间）。
 * 纪律：协议枚举原文、角色冻结显示名（DEC-012）、后端业务数据（名称/备注/审计内容）不翻译；
 * requestId 原文保留。
 */
export const ZH_CN: Readonly<Record<string, string>> = {
  ...PAGE_ZH_CN,
  'ui.contractDeviceRequired': '至少关联一台符合条件的设备后才能完成；草稿已保存，可在当前步骤继续操作。',
  'ui.consumableThresholdLoading': '正在加载耗材展示阈值来源…',
  'ui.consumableThresholdSetting': '耗材展示阈值来自业务设置 alarm.thresholds（版本 v{version}）。',
  'ui.consumableThresholdFallback': '耗材展示阈值使用明确回退值 10%/30%（原因：{reason}）。',
  // ---------- 通用 ----------
  'common.loading': '加载中…',
  'common.refresh': '刷新',
  'common.prevPage': '上一页',
  'common.nextPage': '下一页',
  'common.empty': '暂无数据',
  'common.stale': '数据可能已过期',
  'common.dataTime': '数据时间：',
  'common.cancel': '取消',
  'common.confirm': '确认',
  'common.reason': '操作原因',
  'common.reasonHint': '必填，将写入审计记录',
  'common.logout': '登出',
  'common.timeZone': '显示时区',
  'common.language': '语言',
  'common.openNav': '打开导航菜单',
  'common.breadcrumb': '面包屑',
  'common.mainMenu': '主菜单',
  'common.pageNotFound': '未找到页面',
  'common.notification.unread': '通知，{count} 条未读',
  'common.notification.none': '通知，无未读',

  // ---------- 菜单分组 ----------
  'menu.group.device': '设备管理',
  'menu.group.esg': 'ESG管理',
  'menu.group.contract': '合约管理',
  'menu.group.platform': '平台管理',

  // ---------- 菜单项（pageState） ----------
  'menu.dashboard': '概览',
  'menu.device-view': '查看设备',
  'menu.device-operate': '操作设备',
  'menu.device-group': '设备群管理',
  'menu.configurations': '配置管理',
  'menu.device-consumable': '耗材查看',
  'menu.alarms': '告警与事件',
  'menu.media': '媒体管理',
  'menu.esg-overview': 'ESG概览',
  'menu.esg-device': '设备ESG信息',
  'menu.contract-modify': '合约查询及修改',
  'menu.settings': '用户管理',
  'menu.customers': '客户管理',
  'menu.sites': '站点管理',
  'menu.licenses': '授权管理',
  'menu.device-users': '设备用户',
  'menu.audit-logs': '审计日志',
  'menu.device-manage': '设备管理详情',
  'menu.contract-new': '新建合约',
  'menu.contract-detail': '合约详情',
  'menu.ota-campaigns': 'OTA 升级',
  'menu.ota-packages': '固件包管理',
  'menu.login': '登录',
  'menu.forbidden': '无权访问',

  // ---------- 错误映射（API 错误码统一翻译；requestId 原文保留） ----------
  'error.forbidden.title': '无权访问',
  'error.forbidden.detail': '当前角色无权查看或操作该数据。如认为有误，请联系管理员。',
  'error.versionConflict.title': '数据已被他人修改',
  'error.versionConflict.detail': '当前页面数据版本已过期，请刷新后重试。',
  'error.generic.title': '操作失败',
  'error.generic.detail': '网络或服务暂不可用，请稍后重试。',
  'error.code.FORBIDDEN': '无权访问',
  'error.code.UNAUTHENTICATED': '未认证或登录已过期',
  'error.code.NOT_FOUND': '资源不存在或无权访问',
  'error.code.VERSION_CONFLICT': '数据版本冲突',
  'error.code.CONFLICT': '操作冲突',
  'error.code.VALIDATION_FAILED': '请求校验失败',
  'error.code.INTERNAL_ERROR': '服务器内部错误',
  'error.codeLabel': '错误码：',
} as const;
