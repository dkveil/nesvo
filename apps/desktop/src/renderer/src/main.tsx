import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import { App } from './app';
import './styles.css';

if (navigator.userAgent.includes('Macintosh'))
  document.documentElement.dataset.platform = 'mac';
const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
