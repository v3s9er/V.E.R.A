import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { parseToolPortalPath } from './tool-portal-contract';
import './styles.css';

const RoutedApp = lazy(async () => {
  const portalTool = parseToolPortalPath(window.location.pathname);
  if (portalTool) {
    const { ToolPortal } = await import('./ToolPortal');
    return { default: () => <ToolPortal initialTool={portalTool} /> };
  }
  const { App } = await import('./App');
  return { default: App };
});

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <AppErrorBoundary><Suspense fallback={<main className="app-route-loading" role="status">불러오는 중…</main>}><RoutedApp /></Suspense></AppErrorBoundary>
    </StrictMode>,
  );
}
