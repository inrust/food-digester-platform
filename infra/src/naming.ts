/**
 * IAC-01 资源命名。
 *
 * 全部应用资源名携带环境前缀 `fdp-{env}-{suffix}`（技术对接要求：资源名支持环境前缀）；
 * dev/staging/prod 通过不同 envName 获得完全隔离的资源名（实施方案 §5.2）。
 */

export const PROJECT_PREFIX = 'fdp' as const;

export class Naming {
  constructor(readonly envName: string) {}

  /** 通用资源名：fdp-{env}-{suffix}。 */
  name(suffix: string): string {
    return `${PROJECT_PREFIX}-${this.envName}-${suffix}`;
  }

  /** AWS IoT Rule 名称仅允许 [A-Za-z0-9_]，连字符统一转为下划线。 */
  iotRule(suffix: string): string {
    return this.name(suffix).replace(/-/g, '_');
  }
}
