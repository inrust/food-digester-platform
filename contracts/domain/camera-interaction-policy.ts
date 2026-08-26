/**
 * DEC-009 摄像头交互语义策略（暂定值的可执行扩展点）。
 *
 * 事实源：contracts/domain/camera-interaction-policy.json
 * （本文件常量必须与之一致，由单元测试强制）。
 * 决策追溯：DEC-009@0.2.0（status=pending，全部为定性规则，已可直接执行）。
 *
 * 消费方：BE-MED-01、FE-06（设备详情摄像头区）、FE-12、FE-14（Media 页面）。
 */

export type CameraPolicyStatus = 'provisional' | 'frozen';

export type CameraViewingScope = 'latest-authorized-media-only' | 'history-timeline' | 'live';
export type CameraRefreshMode = 'manual-only' | 'polling' | 'push';

export interface CameraInteractionPolicy {
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
 * 暂定值（DEC-009 v0.2.0，pending）：
 * V1 仅查看最新授权 Media 并手动刷新；实时视频流暂不实现。
 */
export const CAMERA_INTERACTION_POLICY: CameraInteractionPolicy = {
  policyVersion: '0.1.0',
  status: 'provisional',
  viewing: {
    scope: 'latest-authorized-media-only',
    consumers: ['BE-MED-01', 'FE-06', 'FE-12', 'FE-14'],
    note: '摄像头画面仅呈现设备已上报、且当前授权范围内的最新 Media 对象（经 BE-MED-01 元数据 + 授权校验）；不得提供历史连拍浏览或时间轴回放入口（历史查询走 FE-14 Media 列表）。',
  },
  refresh: {
    mode: 'manual-only',
    consumers: ['FE-06', 'FE-12'],
    note: '画面更新仅由用户手动刷新触发；禁止前端轮询定时拉取最新画面（自动刷新属于实时语义，V1 不提供）。',
  },
  liveStreaming: {
    enabled: false,
    consumers: ['BE-MED-01', 'FE-06', 'FE-12'],
    note: '实时视频流暂不实现：不提供播放/停止按钮、不接入任何流媒体协议、不预留 streaming 接口。上级协议未定义该能力；冻结前任何实时流实现视为越界。',
  },
  pendingParameters: [],
  frozenUpgradePath:
    'DEC-009 冻结时：按 decision-change-template 变更 DEC-009 至 >=1.0.0，status 改 frozen；若冻结值启用实时流，需先在上级通信协议中定义流媒体能力并新增契约与 Topic。',
} as const;

/** 摄像头查看范围。V1 暂定为 latest-authorized-media-only。 */
export function getCameraViewingScope(): CameraViewingScope {
  return CAMERA_INTERACTION_POLICY.viewing.scope;
}

/** 画面刷新方式。V1 暂定为 manual-only。 */
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

/** 策略当前状态：provisional 表示 DEC-009 未冻结。 */
export function getCameraPolicyStatus(): CameraPolicyStatus {
  return CAMERA_INTERACTION_POLICY.status;
}
