#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function operationIds(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((item) => operationIds(item, found));
  else if (value && typeof value === 'object') {
    if (typeof value.operationId === 'string') found.add(value.operationId);
    Object.values(value).forEach((item) => operationIds(item, found));
  }
  return found;
}

export function auditAdminWebDelivery(root, options = {}) {
  const errors = [];
  const appRoot = join(root, 'apps/admin-web');
  const requiredFiles = [
    'index.html',
    'vite.config.ts',
    'src/main.tsx',
    'src/app/App.tsx',
    'src/app/composition-root.ts',
    'src/app/controllers.tsx',
    'src/app/LoginPage.tsx',
    'src/app/app.css',
    'test/app-smoke.test.tsx',
  ];
  for (const file of requiredFiles) {
    if (!existsSync(join(appRoot, file))) errors.push(`缺少浏览器运行文件：${file}`);
  }

  const packagePath = join(appRoot, 'package.json');
  if (existsSync(packagePath)) {
    const scripts = readJson(packagePath).scripts ?? {};
    for (const name of ['dev', 'build', 'start']) {
      if (typeof scripts[name] !== 'string' || !scripts[name].includes('vite'))
        errors.push(`package.json 缺少可运行 ${name} 脚本`);
    }
  } else errors.push('缺少 apps/admin-web/package.json');

  const manifestPath = join(appRoot, 'admin-web-delivery-manifest.json');
  const routesPath = join(appRoot, 'src/router/routes.ts');
  const appPath = join(appRoot, 'src/app/App.tsx');
  const openapiPath = join(root, 'contracts/rest/openapi.bundle.json');
  if (!existsSync(manifestPath)) errors.push('缺少管理后台交付清单');
  else {
    const manifest = readJson(manifestPath);
    const routesSource = existsSync(routesPath) ? readFileSync(routesPath, 'utf8') : '';
    const appSource = existsSync(appPath) ? readFileSync(appPath, 'utf8') : '';
    for (const route of manifest.routes ?? []) {
      if (!routesSource.includes(`path: '${route.path}'`) && !routesSource.includes(route.path))
        errors.push(`路由未注册：${route.path}`);
      if (!appSource.includes(`'${route.pageState}'`)) errors.push(`路由无页面实现：${route.pageState}`);
    }
    if (!existsSync(openapiPath)) errors.push('缺少 bundled OpenAPI');
    else {
      const delivered = operationIds(readJson(openapiPath));
      for (const id of manifest.operationIds ?? []) {
        if (!delivered.has(id)) errors.push(`OpenAPI operationId 未交付：${id}`);
      }
    }
  }

  const mainSource = existsSync(join(appRoot, 'src/main.tsx'))
    ? readFileSync(join(appRoot, 'src/main.tsx'), 'utf8')
    : '';
  if (!mainSource.includes("'./shell/shell.css'") || !mainSource.includes("'./app/app.css'"))
    errors.push('浏览器入口未装载壳层与页面 CSS');

  if (options.requireBuild !== false) {
    const webDist = join(appRoot, 'dist/web');
    const assets = join(webDist, 'assets');
    if (!existsSync(join(webDist, 'index.html'))) errors.push('缺少 dist/web/index.html 浏览器构建产物');
    if (!existsSync(assets)) errors.push('缺少 dist/web/assets 构建产物');
    else {
      const files = readdirSync(assets);
      if (!files.some((file) => file.endsWith('.js'))) errors.push('浏览器构建产物缺少 JavaScript bundle');
      if (!files.some((file) => file.endsWith('.css'))) errors.push('浏览器构建产物缺少 CSS bundle');
      for (const file of files.filter((name) => name.endsWith('.js'))) {
        const source = readFileSync(join(assets, file), 'utf8');
        if (source.includes('__vite-browser-external') || source.includes('PrismaClient')) {
          errors.push(`浏览器 bundle 混入 Node/数据库依赖：${file}`);
        }
      }
    }
  }
  return errors;
}

function main() {
  const root = process.cwd();
  const errors = auditAdminWebDelivery(root);
  if (errors.length > 0) {
    errors.forEach((error) => console.error(`管理后台交付阻断：${error}`));
    process.exitCode = 1;
    return;
  }
  console.log('管理后台交付检查通过：入口、组合根、路由页面、OpenAPI operationId、CSS 与浏览器构建产物均已就绪');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
