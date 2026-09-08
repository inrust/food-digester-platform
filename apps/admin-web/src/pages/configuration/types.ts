/**
 * FE-09 Configuration 数据类型：镜像 admin-configuration-api.json（BE-CFG-01）。
 */

export interface ConfigurationPayloadView {
  readonly heartbeatInterval: number;
  readonly telemetryInterval: number;
  readonly cameraRefreshInterval: number;
  readonly temperatureThreshold: number;
}

export interface ConfigurationSummaryView {
  readonly configurationId: string;
  readonly name: string;
  readonly targetModel: string | null;
  readonly targetDeviceId: string | null;
  readonly versionCount: number;
  readonly latestPublishedVersion: number | null;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface ConfigurationVersionView {
  readonly versionId: string;
  readonly configurationId: string;
  readonly version: number;
  readonly payload: ConfigurationPayloadView;
  readonly status: 'DRAFT' | 'PUBLISHED';
  readonly effectiveAt: string | null;
  readonly changeNote: string | null;
  readonly createdAt: string;
}

/** 派生只读上下文：从业务实体读取，只读展示，不得随配置提交。 */
export interface ConfigurationDerivedContextView {
  readonly alias: string | null;
  readonly site: string | null;
  readonly region: string | null;
  readonly subregion: string | null;
  readonly contract: { readonly contractNumber: string; readonly name: string } | null;
}

export interface ConfigurationDetailView extends ConfigurationSummaryView {
  readonly versions: readonly ConfigurationVersionView[];
  readonly derivedContext: ConfigurationDerivedContextView | null;
}

export interface ConfigurationPublishResultView {
  readonly version: ConfigurationVersionView;
  readonly notifiedDeviceIds: readonly string[];
}

export interface ConfigurationSyncStatusTargetView {
  readonly deviceId: string;
  readonly notificationStatus: 'PENDING' | 'PUBLISHED' | 'FAILED';
}

export interface ConfigurationSyncStatusView {
  readonly configurationId: string;
  readonly version: number;
  readonly status: 'DRAFT' | 'PUBLISHED';
  readonly effectiveAt: string | null;
  readonly targets: readonly ConfigurationSyncStatusTargetView[];
}
