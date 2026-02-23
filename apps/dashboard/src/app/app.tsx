import { useState, Suspense, lazy } from 'react';
import { NavRail } from '../components/nav-rail';

const TestingView = lazy(() => import('./testing-view').then(m => ({ default: m.TestingView })));
const DiscoveryView = lazy(() => import('./discovery-view').then(m => ({ default: m.DiscoveryView })));
const SettingsView = lazy(() => import('./settings-view').then(m => ({ default: m.SettingsView })));

type View = 'testing' | 'discovery' | 'settings';
type SidebarTab = 'chat' | 'files';

function ViewLoader() {
  return (
    <div className="view-loader">
      <div className="loader-spinner" />
      <style>{`
        .view-loader {
          display: flex;
          align-items: center;
          justify-content: center;
          flex: 1;
          background: #0a0a0a;
        }
        .loader-spinner {
          width: 32px;
          height: 32px;
          border: 3px solid #1f1f1f;
          border-top-color: #3b82f6;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export function App() {
  const [currentView, setCurrentView] = useState<View>('testing');
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [pendingTestPrompt, setPendingTestPrompt] = useState<string | undefined>();

  const handleNavigate = (view: View, tab?: SidebarTab) => {
    if (view === 'testing' && tab) {
      setSidebarTab(tab);
      if (sidebarCollapsed) setSidebarCollapsed(false);
    }
    setCurrentView(view);
  };

  const handleGenerateTest = (pageUrl: string) => {
    setPendingTestPrompt(`Generate E2E tests for ${pageUrl}`);
    setSidebarTab('chat');
    if (sidebarCollapsed) setSidebarCollapsed(false);
    setCurrentView('testing');
  };

  return (
    <div className="app-shell">
      <NavRail
        activeView={currentView}
        activeSidebarTab={sidebarTab}
        sidebarCollapsed={sidebarCollapsed}
        onNavigate={handleNavigate}
        onToggleCollapse={() => setSidebarCollapsed(prev => !prev)}
      />

      <Suspense fallback={<ViewLoader />}>
        {currentView === 'testing' && (
          <TestingView
            sidebarTab={sidebarTab}
            sidebarCollapsed={sidebarCollapsed}
            onSidebarTabChange={setSidebarTab}
            pendingPrompt={pendingTestPrompt}
            onPromptConsumed={() => setPendingTestPrompt(undefined)}
          />
        )}

        {currentView === 'discovery' && (
          <DiscoveryView onGenerateTest={handleGenerateTest} />
        )}

        {currentView === 'settings' && <SettingsView />}
      </Suspense>

      <style>{`
        .app-shell {
          display: flex;
          height: 100vh;
          background: #0a0a0a;
          overflow: hidden;
        }
      `}</style>
    </div>
  );
}

export default App;
