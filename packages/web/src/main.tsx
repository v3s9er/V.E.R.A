import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { parseToolPortalPath } from './tool-portal-contract';
import './styles.css';
import './components/AgentSurface.css';

const overlayChrome = window.mrRobotDesktop?.windowChrome === 'overlay';
if (overlayChrome) document.documentElement.dataset.windowChrome = 'overlay';

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
      {overlayChrome && <div className="desktop-drag-region" aria-hidden="true"><span>Mr.Robot</span></div>}
      <AppErrorBoundary><Suspense fallback={<main className="app-route-loading" role="status">불러오는 중…</main>}><RoutedApp /></Suspense></AppErrorBoundary>
    </StrictMode>,
  );
}
