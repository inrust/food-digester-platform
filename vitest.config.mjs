import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

/**
 * ENG-02 Vitest 配置：apps/packages/infra 的单元测试统一由 Vitest 运行。
 * 契约层（contracts/**）与仓库脚本（scripts/**）测试保持 node:test 运行器，
 * 分别经 pnpm test:contracts / pnpm test:scripts 执行。
 *
 * alias 指向共享包源码，测试不依赖 dist 构建产物。
 */
export default defineConfig({
  resolve: {
    alias: {
      '@fdp/aws-clients': r('./packages/aws-clients/src/index.ts'),
      '@fdp/database': r('./packages/database/src/index.ts'),
      '@fdp/domain': r('./packages/domain/src/index.ts'),
      '@fdp/infra': r('./infra/src/index.ts'),
      '@fdp/observability': r('./packages/observability/src/index.ts'),
    },
  },
  test: {
    include: ['apps/*/test/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'infra/test/**/*.test.ts'],
  },
});
