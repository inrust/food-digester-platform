/**
 * DEC-009 摄像头交互语义策略（冻结策略）。
 *
 * 事实源：contracts/domain/camera-interaction-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-009@2.0.0（status=frozen，包含归档入口与独立预览参数）。
 *
 * 消费方：BE-MED-01、FE-06（设备详情摄像头区）、FE-12、FE-14（Media 页面）。
 */

export type CameraPolicyStatus = 'provisional' | 'frozen';

export type CameraViewingScope = 'latest-authorized-media-only' | 'history-timeline' | 'live';
export type CameraRefreshMode = 'manual-only' | 'polling' | 'push';

export interface CameraInteractionPolicy {
  readonly liveImage: {
    readonly capability: string;
    readonly defaultEnabled: boolean;
    readonly activation: string;
    readonly pollIntervalMs: number;
    readonly uploadIntervalMs: number;
    readonly readIntervalMs: number;
    readonly leaseSeconds: number;
    readonly renewAfterSeconds: number;
    readonly frameTtlSeconds: number;
    readonly dedupSeconds: number;
    readonly minUploadIntervalMs: number;
    readonly maxImageBytes: number;
    readonly maxRequestBytes: number;
    readonly defaultLongEdgePx: number;
    readonly maxDimensionPx: number;
    readonly maxPixels: number;
    readonly maxFutureSkewSeconds: number;
    readonly maxViewersPerDevice: number;
    readonly consumers: readonly string[];
    readonly note: string;
  };

  readonly policyVersion: string;
  readonly status: CameraPolicyStatus;
  readonly viewing: {
    readonly scope: CameraViewingScope;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly refresh: {
    readonly mode: CameraRefreshMode;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly liveStreaming: {
    /** 实时视频流能力，V1 锁定为 false。 */
    readonly enabled: false;
    readonly consumers: readonly string[];
    readonly note: string;
  };
  readonly pendingParameters: readonly string[];
  readonly frozenUpgradePath: string;
}

/**
 * 冻结值（DEC-009 v2.0.0）：
 * 既有归档入口手动刷新；liveImage 承接默认关闭的图片预览。
 */
export const CAMERA_INTERACTION_POLICY: CameraInteractionPolicy = {
  policyVersion: '2.0.0',
  status: 'frozen',
  viewing: {
    scope: 'latest-authorized-media-only',
    consumers: ['BE-MED-01', 'FE-06', 'FE-12', 'FE-14'],
    note: '摄像头画面仅呈现设备已上报、且当前授权范围内的最新 Media 对象（经 BE-MED-01 元数据 + 授权校验）；不得提供历史连拍浏览或时间轴回放入口（历史查询走 FE-14 Media 列表）。',
  },
  refresh: {
    mode: 'manual-only',
    consumers: ['FE-06', 'FE-12'],
    note: '既有归档 Media 入口由用户手动刷新；启用的 liveImage 入口按独立租约和刷新参数运行。',
  },
  liveStreaming: {
    enabled: false,
    consumers: ['BE-MED-01', 'FE-06', 'FE-12'],
    note: '实时视频流能力保持关闭；图片预览由 liveImage 的 REST 租约和 Base64 帧契约约束。',
  },
  pendingParameters: [],
  frozenUpgradePath: '变更预览参数、能力准入及媒体语义须提升 DEC-009 与策略版本。',
  liveImage: {
    capability: 'live-image-v1',
    defaultEnabled: false,
    activation: 'device-local-opt-in-and-server-device-allowlist',
    pollIntervalMs: 5000,
    uploadIntervalMs: 2000,
    readIntervalMs: 2000,
    leaseSeconds: 30,
    renewAfterSeconds: 10,
    frameTtlSeconds: 10,
    dedupSeconds: 15,
    minUploadIntervalMs: 1000,
    maxImageBytes: 131072,
    maxRequestBytes: 184320,
    defaultLongEdgePx: 640,
    maxDimensionPx: 1920,
    maxPixels: 2073600,
    maxFutureSkewSeconds: 2,
    maxViewersPerDevice: 16,
    consumers: ['IMG-01', 'IMG-02', 'IMG-03', 'IMG-04', 'BE-MED-01', 'FE-06'],
    note: '设备本地版本支持且显式开启；服务端按 deviceId 白名单启用，两者均缺省关闭。旧媒体刷新策略仅用于已有归档入口。新接口按租约授权轮询。',
  },
} as const;

/** 摄像头查看范围。V1 冻结为 latest-authorized-media-only。 */
export function getCameraViewingScope(): CameraViewingScope {
  return CAMERA_INTERACTION_POLICY.viewing.scope;
}

/** 画面刷新方式。V1 冻结为 manual-only。 */
export function getCameraRefreshMode(): CameraRefreshMode {
  return CAMERA_INTERACTION_POLICY.refresh.mode;
}

/** 是否允许前端自动轮询拉取最新画面：V1 恒为 false。 */
export function isCameraAutoRefreshAllowed(): boolean {
  return CAMERA_INTERACTION_POLICY.refresh.mode !== 'manual-only';
}

/** 实时视频流是否启用：V1 恒为 false（锁定规则）。 */
export function isLiveStreamingEnabled(): boolean {
  return CAMERA_INTERACTION_POLICY.liveStreaming.enabled;
}

/** 策略当前状态：frozen 表示 DEC-009 已冻结。 */
export function getCameraPolicyStatus(): CameraPolicyStatus {
  return CAMERA_INTERACTION_POLICY.status;
}
