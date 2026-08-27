/**
 * AUTH-03 Device auth middleware（框架无关装饰器）。
 *
 * 适用于 Device API（/api/v1/device/*，mTLS 自定义域名入口，IAC-01）：
 * 从请求提取 API Gateway 客户端证书上下文与路径 deviceId，校验后注入
 * DeviceAuthContext（device/customer context）供业务 Handler 使用。
 */
import type { DbClient } from '@fdp/database';
import type { ClientCertIdentity } from './mtls-context.js';
import { verifyDeviceCertificate } from './verifier.js';
import type { DeviceAuthContext } from './verifier.js';

export interface DeviceAuthGuardOptions<TReq> {
  readonly client: DbClient;
  /** 从请求提取 `$context.identity.clientCert`（API Gateway 代理集成事件）。 */
  readonly identityOf: (req: TReq) => ClientCertIdentity | undefined;
  /** 从请求提取路径 deviceId；返回 undefined 表示该路由不强制设备归属。 */
  readonly deviceIdOf: (req: TReq) => string | undefined;
  /** 注入时钟（测试用）。 */
  readonly now?: () => Date;
}

export function withDeviceAuth<TReq, TRes>(
  options: DeviceAuthGuardOptions<TReq>,
  handler: (req: TReq, auth: DeviceAuthContext) => TRes | Promise<TRes>,
): (req: TReq) => Promise<TRes> {
  return async (req) => {
    const requestedDeviceId = options.deviceIdOf(req);
    const verifyOptions =
      options.now || requestedDeviceId !== undefined
        ? {
            ...(requestedDeviceId !== undefined ? { requestedDeviceId } : {}),
            ...(options.now ? { now: options.now() } : {}),
          }
        : {};
    const auth = await verifyDeviceCertificate(options.client, options.identityOf(req), verifyOptions);
    return handler(req, auth);
  };
}
