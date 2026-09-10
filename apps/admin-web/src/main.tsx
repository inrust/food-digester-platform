import { createRoot } from 'react-dom/client';
import { AdminWebApp } from './app/App.js';
import { createAdminWebServices } from './app/composition-root.js';
import { loadRuntimeConfig } from './app/runtime-config.js';
import './shell/shell.css';
import './app/app.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('Missing #root mount element');

const root = createRoot(rootElement);
try {
  const config = loadRuntimeConfig(import.meta.env);
  root.render(<AdminWebApp services={createAdminWebServices(config)} />);
} catch (error) {
  const message = error instanceof Error ? error.message : '管理后台初始化失败';
  root.render(
    <main className="standalone-page" role="alert">
      <h1>无法启动管理后台</h1>
      <p>{message}</p>
    </main>,
  );
}
