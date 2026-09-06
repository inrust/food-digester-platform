/**
 * FE-01 会话存储端口与默认内存实现。
 *
 * V1 决策：默认仅内存持有 Token（刷新页面需重新登录），避免 Refresh Token 落入
 * localStorage 遭受 XSS 窃取；持久化策略若变更需经安全评审。SessionStore 为注入端口，
 * FE-02 壳层可按评审结论绑定 sessionStorage 等实现。
 */

export interface SessionStore<T> {
  load(): T | null;
  save(session: T): void;
  clear(): void;
}

export class InMemorySessionStore<T> implements SessionStore<T> {
  private value: T | null = null;

  load(): T | null {
    return this.value;
  }

  save(session: T): void {
    this.value = session;
  }

  clear(): void {
    this.value = null;
  }
}
