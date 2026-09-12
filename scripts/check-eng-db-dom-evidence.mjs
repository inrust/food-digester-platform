#!/usr/bin/env node
/**
 * ENG/DB/DOM、IAC/AUTH/SEC 与 BE-IOT 证据及开发文档维护门禁。
 *
 * 规则：
 *  1. 纳入治理的任务开发文档中的仓库内 Markdown 链接必须可解析；
 *  2. 开发文档不固化易漂移的测试总数，精确快照统一记录在 docs/audit；
 *  3. Node 与 pnpm 声明必须保持已复验的兼容配对。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENGINEERING_TASK_DOCUMENTS = [
  'docs/dev/ENG-01-Monorepo骨架与模块边界.md',
  'docs/dev/ENG-02-开发质量门禁.md',
  'docs/dev/DB-01-ERD.md',
  'docs/dev/DB-02-数据库基础库.md',
  'docs/dev/DOM-01-设备状态机.md',
  'docs/dev/DOM-02-License状态机.md',
  'docs/dev/DOM-03-审计写入库.md',
  'docs/dev/IAC-01-应用依赖CDK.md',
  'docs/dev/AUTH-01-Cognito认证与角色授权.md',
  'docs/dev/AUTH-02-Onboarding-Token认证.md',
  'docs/dev/AUTH-03-Device-mTLS身份映射.md',
  'docs/dev/AUTH-04-IoT单设备Policy生成器.md',
  'docs/dev/SEC-01-敏感材料保护组件.md',
];

export const IOT_TASK_DOCUMENTS = [
  'docs/dev/BE-IOT-01-IoT-Rule消息封装契约.md',
  'docs/dev/BE-IOT-02-Ingestion校验管线.md',
  'docs/dev/BE-IOT-03-幂等序号缺口与收据模块.md',
  'docs/dev/BE-IOT-04-Heartbeat-Handler.md',
  'docs/dev/BE-IOT-05-Telemetry-Handler.md',
  'docs/dev/BE-IOT-06-ESG-Report-Handler.md',
  'docs/dev/BE-IOT-07-Alarm-Event-Tamper-Handler.md',
  'docs/BE-IOT-08-ACK-Handler分发接线.md',
];

export const DATA_PROCESSING_TASK_DOCUMENTS = [
  'docs/dev/BE-ARC-01-Transactional-Outbox-Publisher.md',
  'docs/dev/BE-ARC-02-S3-Archive-Worker与Manifest.md',
  'docs/dev/BE-RPL-01-消息重放服务和管理接口.md',
  'docs/dev/BE-ESG-01-小时日聚合Worker.md',
];

export const ADMIN_BUSINESS_TASK_DOCUMENTS = [
  'docs/dev/BE-LIC-01-License-Entitlement-API.md',
  'docs/dev/BE-CON-01-Contract-CRUD与状态API.md',
  'docs/dev/BE-CON-02-Contract-Device关联API.md',
  'docs/dev/BE-CFG-01-Configuration版本管理API.md',
  'docs/dev/BE-CNS-01-耗材状态投影与查询API.md',
  'docs/dev/BE-CNS-02-耗材更换申请工作流API.md',
  'docs/dev/BE-DUSR-01-Device-User管理API.md',
  'docs/dev/BE-DUSR-02-设备本地密码验证值生成器.md',
  'docs/dev/BE-ALM-01-Alarm-Event-Tamper-API.md',
  'docs/dev/BE-ALM-02-业务通知适配器.md',
  'docs/dev/BE-ESG-02-ESG-查询与CSV导出API.md',
];

export const ADMIN_MED_RBAC_AUD_DASH_SET_DOCUMENTS = [
  'docs/BE-MED-01-Media上传会话与元数据API.md',
  'docs/BE-RBAC-01-用户角色与Scope管理API.md',
  'docs/BE-AUD-01-审计日志查询API.md',
  'docs/BE-DASH-01-管理后台总览聚合API.md',
  'docs/BE-SET-01-业务设置与字典API.md',
];

export const ADMIN_FRONTEND_TASK_DOCUMENTS = [
  'docs/dev/FE-06-Device列表与详情页面.md',
  'docs/dev/FE-07-Device生命周期操作页面.md',
  'docs/dev/FE-08-License与Entitlement页面.md',
  'docs/dev/FE-09-Configuration与DeviceUser页面.md',
  'docs/dev/FE-10-Alarm与Event与Tamper页面.md',
];

export const ADMIN_FRONTEND_FE11_15_TASK_DOCUMENTS = [
  'docs/dev/FE-11-ESG报表与导出页面.md',
  'docs/dev/FE-12-RemoteCommand页面.md',
  'docs/dev/FE-13-OTA页面.md',
  'docs/dev/FE-14-Media页面.md',
  'docs/dev/FE-15-审计日志页面.md',
];

export const TASK_DOCUMENTS = [
  ...ENGINEERING_TASK_DOCUMENTS,
  ...IOT_TASK_DOCUMENTS,
  ...DATA_PROCESSING_TASK_DOCUMENTS,
  ...ADMIN_BUSINESS_TASK_DOCUMENTS,
  ...ADMIN_MED_RBAC_AUD_DASH_SET_DOCUMENTS,
  ...ADMIN_FRONTEND_TASK_DOCUMENTS,
  ...ADMIN_FRONTEND_FE11_15_TASK_DOCUMENTS,
];

export const SECURITY_TASK_DOCUMENTS = [
  'docs/dev/IAC-01-应用依赖CDK.md',
  'docs/dev/AUTH-01-Cognito认证与角色授权.md',
  'docs/dev/AUTH-02-Onboarding-Token认证.md',
  'docs/dev/AUTH-03-Device-mTLS身份映射.md',
  'docs/dev/AUTH-04-IoT单设备Policy生成器.md',
  'docs/dev/SEC-01-敏感材料保护组件.md',
];

const IOT_AUDIT_REPORT = 'BE-IOT-01至BE-IOT-09全面复盘检查报告-2026-09-07.md';
const DATA_PROCESSING_AUDIT_REPORT = 'BE-ARC-01-02-BE-RPL-01-BE-ESG-01全面复盘检查报告-2026-09-07.md';
const ADMIN_BUSINESS_AUDIT_REPORT = 'BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG全面复盘检查报告-2026-09-08.md';
const ADMIN_BUSINESS_AWS_GUIDE = 'BE-LIC-CON-CFG-CNS-DUSR-ALM-ESG-AWS验收证据采集说明.md';
const ADMIN_MED_RBAC_AUD_DASH_SET_AUDIT_REPORT = 'BE-MED-RBAC-AUD-DASH-SET全面复盘检查报告-2026-09-09.md';
const ADMIN_MED_RBAC_AUD_DASH_SET_AWS_GUIDE = 'BE-MED-RBAC-AUD-DASH-SET-AWS验收证据采集说明.md';
const ADMIN_FRONTEND_AUDIT_REPORT = 'FE-06至FE-10全面复盘检查报告-2026-09-10.md';
const ADMIN_FRONTEND_TARGET_GUIDE = 'FE-06至FE-10-目标环境验收证据采集说明.md';
const ADMIN_FRONTEND_FE11_15_AUDIT_REPORT = 'FE-11至FE-15全面复盘检查报告-2026-09-12.md';
const ADMIN_FRONTEND_FE11_15_TARGET_GUIDE = 'FE-11至FE-15-目标环境验收证据采集说明.md';

export const DATA_PROCESSING_STRICT_REGRESSIONS = [
  {
    finding: 'M-01',
    file: 'apps/ingestion-worker/test/outbox-publisher.test.ts',
    anchor: 'Archive 与 Notification Publisher 职责隔离',
  },
  {
    finding: 'M-02',
    file: 'apps/ingestion-worker/test/outbox-publisher.test.ts',
    anchor: '双 Archive Publisher 并发时同一行只能取得一个租约并发送一次',
  },
  {
    finding: 'M-02-recovery',
    file: 'apps/ingestion-worker/test/outbox-publisher.test.ts',
    anchor: '过期租约可恢复领取，未过期租约不会被抢占',
  },
];

export const IOT_STRICT_REGRESSIONS = [
  {
    finding: 'H-01',
    file: 'apps/ingestion-worker/test/ingest-pipeline.test.ts',
    anchor: 'Quarantine 投递失败只重试当前记录，批次后续记录继续隔离',
  },
  {
    finding: 'H-02',
    file: 'apps/ingestion-worker/test/heartbeat-handler.test.ts',
    anchor: '首次心跳副作用失败后，同一 receipt 重试仍可完成 Onboarding',
  },
  {
    finding: 'H-04',
    file: 'apps/ingestion-worker/test/signals-ack.test.ts',
    anchor: 'PUBLISHED 但服务端当前时间已到期：保存迟到事件且禁止更新成功',
  },
  {
    finding: 'H-05',
    file: 'apps/cloud-api/test/media.test.ts',
    anchor: '过期会话及校验期间到期均拒绝，且不写 MediaObject/不完成会话',
  },
  {
    finding: 'M-01',
    file: 'apps/ingestion-worker/test/ingest-pipeline.test.ts',
    anchor: 'Envelope 失败关闭：字段缺失、Topic 上下文不一致及额外 iot* 字段均隔离',
  },
  {
    finding: 'M-02',
    file: 'apps/ingestion-worker/test/ingest-pipeline.test.ts',
    anchor: 'Topic 上下文不一致',
  },
];

const EXPECTED_TOOLCHAIN = {
  node: '>=24.12 <25',
  nvmrc: '24.12.0',
  packageManager: 'pnpm@10.20.0',
};

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)]+)\)/g;
const VOLATILE_TOTAL = /(?:Vitest|contracts|scripts|合计)\s*(?:[+:=]\s*)?\d+(?:\/\d+)?/iu;
const VOLATILE_FILE_COUNT = /(?:实现|测试)[^。\n]*（\d+\s*项/iu;

export function securityDocumentErrors(content, relativeDocument, decisionRegister) {
  const errors = [];
  if (!content.includes('pnpm verify')) {
    errors.push(`${relativeDocument}: 缺少当前全仓证据命令 pnpm verify`);
  }
  const volatileLine = content
    .split(/\r?\n/u)
    .find(
      (line) =>
        /(?:测试|Vitest|全仓)/iu.test(line) && /(?:\d+\s*个(?:测试)?文件|\d+\s*项(?:断言|测试)|\d+\/\d+)/u.test(line),
    );
  if (volatileLine) errors.push(`${relativeDocument}: 不应固化易漂移的测试文件或用例计数`);

  if (relativeDocument.endsWith('AUTH-01-Cognito认证与角色授权.md')) {
    const decision = decisionRegister?.decisions?.find((entry) => entry.id === 'DEC-012');
    if (!decision || decision.status !== 'frozen' || decision.version !== '1.0.0') {
      errors.push(`${relativeDocument}: DEC-012 登记必须为 frozen@1.0.0`);
    }
    if (!/DEC-012 已冻结为 `1\.0\.0`/u.test(content) || /DEC-012[^。\n]*`pending`/iu.test(content)) {
      errors.push(`${relativeDocument}: DEC-012 文档状态必须与 frozen@1.0.0 一致`);
    }
  }
  return errors;
}

export function iotDocumentErrors(content, relativeDocument) {
  const errors = [];
  if (!content.includes('pnpm verify')) {
    errors.push(`${relativeDocument}: 缺少当前全仓证据命令 pnpm verify`);
  }
  if (!content.includes(IOT_AUDIT_REPORT)) {
    errors.push(`${relativeDocument}: 缺少 BE-IOT 审计快照引用`);
  }
  if (
    relativeDocument.endsWith('BE-IOT-06-ESG-Report-Handler.md') &&
    /(?:重叠[^。\n]*P2002|P2002[^。\n]*重叠)/iu.test(content)
  ) {
    errors.push(`${relativeDocument}: 不得声称不同起点的重叠 Report 会由 P2002 收敛`);
  }
  if (
    relativeDocument.endsWith('BE-IOT-08-ACK-Handler分发接线.md') &&
    /media[^。\n]*(?:另(?:一|有)?路由|NO_HANDLER)/iu.test(content)
  ) {
    errors.push(`${relativeDocument}: Media 必须记录为同一 Ingress 的已注册 Handler，不得声称另路由或 NO_HANDLER`);
  }
  return errors;
}

export function dataProcessingDocumentErrors(content, relativeDocument) {
  const errors = [];
  if (!content.includes('pnpm verify')) {
    errors.push(`${relativeDocument}: 缺少当前全仓证据命令 pnpm verify`);
  }
  if (!content.includes(DATA_PROCESSING_AUDIT_REPORT)) {
    errors.push(`${relativeDocument}: 缺少 BE-ARC/RPL/ESG 审计快照引用`);
  }
  if (/(?:生产接线|调度触发)[^。\n]*(?:归|属)[^。\n]*(?:边界外|IAC)/iu.test(content)) {
    errors.push(`${relativeDocument}: 不得把已要求交付的生产接线声明为边界外`);
  }
  return errors;
}

export function adminBusinessDocumentErrors(content, relativeDocument) {
  const errors = [];
  if (!content.includes('pnpm verify')) errors.push(`${relativeDocument}: 缺少当前全仓证据命令 pnpm verify`);
  if (!content.includes(ADMIN_BUSINESS_AUDIT_REPORT)) errors.push(`${relativeDocument}: 缺少管理后台业务审计快照引用`);
  if (!content.includes(ADMIN_BUSINESS_AWS_GUIDE) || !content.includes('check:aws-admin-business-evidence')) {
    errors.push(`${relativeDocument}: 缺少目标 AWS 管理后台业务回执 Gate 引用`);
  }
  if (
    relativeDocument.endsWith('BE-CNS-01-耗材状态投影与查询API.md') &&
    /DEC-008[^。\n]*(?:待冻结|pending)/iu.test(content)
  ) {
    errors.push(`${relativeDocument}: DEC-008 当前状态必须与 frozen@1.0.0 一致`);
  }
  if (relativeDocument.endsWith('BE-CON-01-Contract-CRUD与状态API.md')) {
    if (!content.includes('DEC-021@1.0.0') || /30\s*天[^。\n]*(?:暂定|待冻结)/iu.test(content)) {
      errors.push(`${relativeDocument}: 30 天窗口必须引用 DEC-021@1.0.0 且不得标记为暂定`);
    }
  }
  if (
    (relativeDocument.endsWith('BE-ALM-02-业务通知适配器.md') ||
      relativeDocument.endsWith('BE-ESG-02-ESG-查询与CSV导出API.md')) &&
    /(?:调度|发送端口|存储|签名)[^。\n]*(?:待部署|边界外)/iu.test(content)
  ) {
    errors.push(`${relativeDocument}: 不得把已完成的生产接线声明为待部署或边界外`);
  }
  return errors;
}

export function adminMedRbacAudDashSetDocumentErrors(content, relativeDocument) {
  const errors = [];
  if (!content.includes('pnpm verify')) errors.push(`${relativeDocument}: 缺少当前全仓证据命令 pnpm verify`);
  if (!content.includes(ADMIN_MED_RBAC_AUD_DASH_SET_AUDIT_REPORT)) {
    errors.push(`${relativeDocument}: 缺少 BE-MED/RBAC/AUD/DASH/SET 审计快照引用`);
  }
  if (
    !content.includes(ADMIN_MED_RBAC_AUD_DASH_SET_AWS_GUIDE) ||
    !content.includes('check:aws-med-rbac-aud-dash-set-evidence')
  ) {
    errors.push(`${relativeDocument}: 缺少本范围目标 AWS 回执 Gate 引用`);
  }
  for (const marker of ['module implemented', 'production wired', 'target verified']) {
    if (!content.includes(marker)) errors.push(`${relativeDocument}: 缺少状态层 ${marker}`);
  }
  if (
    (relativeDocument.endsWith('BE-MED-01-Media上传会话与元数据API.md') ||
      relativeDocument.endsWith('BE-DASH-01-管理后台总览聚合API.md')) &&
    (!content.includes('DEC-024@1.0.0') || /(?:上传限制|在线阈值)[^。\n]*(?:暂定|待冻结|provisional)/iu.test(content))
  ) {
    errors.push(`${relativeDocument}: 冻结参数必须引用 DEC-024@1.0.0 且不得保留暂定状态`);
  }
  if (
    relativeDocument.endsWith('BE-SET-01-业务设置与字典API.md') &&
    (!content.includes('STORED_ONLY') || !content.includes('ACTIVE/BE-CMD-01'))
  ) {
    errors.push(`${relativeDocument}: 必须明确设置的运行时消费状态`);
  }
  return errors;
}

export function adminFrontendDocumentErrors(content, relativeDocument) {
  const errors = [];
  const isFe11To15 = ADMIN_FRONTEND_FE11_15_TASK_DOCUMENTS.includes(relativeDocument);
  const auditReport = isFe11To15 ? ADMIN_FRONTEND_FE11_15_AUDIT_REPORT : ADMIN_FRONTEND_AUDIT_REPORT;
  const targetGuide = isFe11To15 ? ADMIN_FRONTEND_FE11_15_TARGET_GUIDE : ADMIN_FRONTEND_TARGET_GUIDE;
  const targetGate = isFe11To15 ? 'check:admin-web-fe11-15-target-evidence' : 'check:admin-web-target-evidence';
  for (const marker of ['module present', 'app integrated', 'browser verified', 'target integrated']) {
    if (!content.includes(marker)) errors.push(`${relativeDocument}: 缺少四层状态 ${marker}`);
  }
  if (!content.includes(auditReport)) {
    errors.push(`${relativeDocument}: 缺少对应前端审计报告引用`);
  }
  if (!content.includes(targetGuide) || !content.includes(targetGate)) {
    errors.push(`${relativeDocument}: 缺少管理后台目标环境回执 Gate 引用`);
  }
  for (const marker of ['Owner', '关闭条件', '验证命令']) {
    if (!content.includes(marker)) errors.push(`${relativeDocument}: 可追踪问题缺少 ${marker}`);
  }
  if (content.includes('✅')) errors.push(`${relativeDocument}: 不得以任务级勾选替代分层验收状态`);

  const staleByDocument = new Map([
    ['FE-06-Device列表与详情页面.md', /媒体区仅元数据|内容预览需.+页面集成/iu],
    ['FE-07-Device生命周期操作页面.md', /退役记录无 GET|跨会话无法回填确认状态/iu],
    ['FE-08-License与Entitlement页面.md', /无全量 License 列表|列表复用.+listDevices/iu],
    ['FE-09-Configuration与DeviceUser页面.md', /同步状态.+仅有同步版本号|USERS_CHANGED 投递状态无查询接口/iu],
    ['FE-10-Alarm与Event与Tamper页面.md', /siteId 筛选为自由文本|视觉样式待.+补充/iu],
    ['FE-11-ESG报表与导出页面.md', /周\/月聚合基于已加载行|跨页全量聚合需/iu],
    ['FE-13-OTA页面.md', /失败原因按设备展示无 API 来源|operationId 重复失败/iu],
  ]);
  const stale = [...staleByDocument].find(([suffix]) => relativeDocument.endsWith(suffix))?.[1];
  if (stale?.test(content)) errors.push(`${relativeDocument}: 仍包含 P1 修复前的陈旧缺口描述`);
  return errors;
}

export function iotRegressionEvidenceErrors(root, regressions = IOT_STRICT_REGRESSIONS) {
  const errors = [];
  for (const regression of regressions) {
    const testPath = resolve(root, regression.file);
    if (!existsSync(testPath)) {
      errors.push(`${regression.finding}: 永久回归测试文件不存在: ${regression.file}`);
      continue;
    }
    if (!readFileSync(testPath, 'utf8').includes(regression.anchor)) {
      errors.push(`${regression.finding}: 永久回归测试锚点缺失: ${regression.anchor}`);
    }
  }
  return errors;
}

export function checkEngDbDomEvidence(root, documentPaths = TASK_DOCUMENTS) {
  const errors = [];
  const packagePath = resolve(root, 'package.json');
  const nvmrcPath = resolve(root, '.nvmrc');
  const decisionRegisterPath = resolve(root, 'contracts/decisions/decision-register.json');
  let decisionRegister;
  if (documentPaths.some((path) => SECURITY_TASK_DOCUMENTS.includes(path))) {
    if (!existsSync(decisionRegisterPath)) {
      errors.push('缺少 contracts/decisions/decision-register.json，无法核对决策状态');
    } else {
      decisionRegister = JSON.parse(readFileSync(decisionRegisterPath, 'utf8'));
    }
  }

  if (!existsSync(packagePath) || !existsSync(nvmrcPath)) {
    errors.push('缺少 package.json 或 .nvmrc，无法核对工具链证据');
  } else {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
    const nvmrc = readFileSync(nvmrcPath, 'utf8').trim();
    if (manifest.engines?.node !== EXPECTED_TOOLCHAIN.node) {
      errors.push(`engines.node 必须为 ${EXPECTED_TOOLCHAIN.node}`);
    }
    if (manifest.packageManager !== EXPECTED_TOOLCHAIN.packageManager) {
      errors.push(`packageManager 必须为 ${EXPECTED_TOOLCHAIN.packageManager}`);
    }
    if (nvmrc !== EXPECTED_TOOLCHAIN.nvmrc) {
      errors.push(`.nvmrc 必须为 ${EXPECTED_TOOLCHAIN.nvmrc}`);
    }
  }

  for (const relativeDocument of documentPaths) {
    const documentPath = resolve(root, relativeDocument);
    if (!existsSync(documentPath)) {
      errors.push(`${relativeDocument}: 文档不存在`);
      continue;
    }
    const content = readFileSync(documentPath, 'utf8');
    if (VOLATILE_TOTAL.test(content) || VOLATILE_FILE_COUNT.test(content)) {
      errors.push(`${relativeDocument}: 不应固化易漂移的测试数量，请引用 pnpm verify 和审计快照`);
    }
    if (SECURITY_TASK_DOCUMENTS.includes(relativeDocument)) {
      errors.push(...securityDocumentErrors(content, relativeDocument, decisionRegister));
    }
    if (IOT_TASK_DOCUMENTS.includes(relativeDocument)) {
      errors.push(...iotDocumentErrors(content, relativeDocument));
    }
    if (DATA_PROCESSING_TASK_DOCUMENTS.includes(relativeDocument)) {
      errors.push(...dataProcessingDocumentErrors(content, relativeDocument));
    }
    if (ADMIN_BUSINESS_TASK_DOCUMENTS.includes(relativeDocument)) {
      errors.push(...adminBusinessDocumentErrors(content, relativeDocument));
    }
    if (ADMIN_MED_RBAC_AUD_DASH_SET_DOCUMENTS.includes(relativeDocument)) {
      errors.push(...adminMedRbacAudDashSetDocumentErrors(content, relativeDocument));
    }
    if (
      ADMIN_FRONTEND_TASK_DOCUMENTS.includes(relativeDocument) ||
      ADMIN_FRONTEND_FE11_15_TASK_DOCUMENTS.includes(relativeDocument)
    ) {
      errors.push(...adminFrontendDocumentErrors(content, relativeDocument));
    }

    for (const match of content.matchAll(MARKDOWN_LINK)) {
      const target = match[1].trim();
      if (/^(?:https?:|mailto:|#)/u.test(target)) continue;
      const pathOnly = decodeURIComponent(target.split('#', 1)[0]);
      if (!existsSync(resolve(dirname(documentPath), pathOnly))) {
        errors.push(`${relativeDocument}: 链接目标不存在: ${target}`);
      }
    }
  }

  if (documentPaths.some((document) => IOT_TASK_DOCUMENTS.includes(document))) {
    errors.push(...iotRegressionEvidenceErrors(root));
  }
  if (documentPaths.some((document) => DATA_PROCESSING_TASK_DOCUMENTS.includes(document))) {
    errors.push(...iotRegressionEvidenceErrors(root, DATA_PROCESSING_STRICT_REGRESSIONS));
  }

  return errors;
}

function main() {
  const root = process.argv[2] ?? process.cwd();
  const errors = checkEngDbDomEvidence(root);
  for (const error of errors) console.error(error);
  if (errors.length === 0)
    console.log('ENG/DB/DOM/IAC/AUTH/SEC/BE-IOT/BE-ARC/RPL/ESG/管理后台业务与前端 证据与开发文档检查通过');
  process.exitCode = errors.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
