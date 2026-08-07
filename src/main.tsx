import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { LanguageProvider } from './lib/i18n.ts';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <LanguageProvider>
        <App />
      </LanguageProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// No code-splitting here today, but this is zero-cost insurance: if that
// ever changes, a tab left open across a deploy won't be stuck on a dead
// chunk reference — see scrapbook's main.tsx for the concrete failure mode.
window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});
