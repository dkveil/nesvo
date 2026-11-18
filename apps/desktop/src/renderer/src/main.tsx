import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist';
import { App } from './app';
import { AppErrorBoundary } from './app-error-boundary';
import './styles.css';

let colorSchemeApplied = false;
window.nesvo.onAppliedColorScheme(scheme => {
  colorSchemeApplied = true;
  document.documentElement.classList.toggle('dark', scheme === 'dark');
});
if (!colorSchemeApplied) document.documentElement.classList.add('dark');
if (navigator.userAgent.includes('Macintosh'))
  document.documentElement.dataset.platform = 'mac';
const describeFailure = (value: unknown) =>
  value instanceof Error
    ? {
        message: value.message.slice(0, 2000),
        stack: value.stack?.slice(0, 16_000),
      }
    : { message: String(value).slice(0, 2000) };
const reportUnhandled = (value: unknown) => {
  try {
    window.nesvo.reportError({ kind: 'unhandled', ...describeFailure(value) });
  } catch {
    return;
  }
};
window.addEventListener('error', event =>
  reportUnhandled(event.error ?? event.message),
);
window.addEventListener('unhandledrejection', event =>
  reportUnhandled(event.reason),
);
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
