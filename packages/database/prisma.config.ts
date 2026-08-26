/**
 * Prisma 7 配置：连接 URL 从 schema 移至本文件（prisma 7 起 schema 不再支持 url）。
 * 仅在执行 prisma migrate 等 CLI 时读取；应用运行时由 PrismaClient 构造参数传入。
 */
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/fdp',
  },
});
