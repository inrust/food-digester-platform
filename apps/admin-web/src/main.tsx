import { translate } from './i18n/i18n.js';
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
  const message = error instanceof Error ? error.message : translate('ui.6ef89dde9760');
  root.render(
    <main className="standalone-page" role="alert">
      <h1>{translate('ui.f7bfca28b220')}</h1>
      <p>{message}</p>
    </main>,
  );
}
