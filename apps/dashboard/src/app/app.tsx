import { useState, Suspense, lazy } from 'react';

// Lazy load views for code-splitting
const LandingPage = lazy(() => import('./landing-page').then(m => ({ default: m.LandingPage })));
const ProjectOverview = lazy(() => import('./project-overview').then(m => ({ default: m.ProjectOverview })));
const TestingView = lazy(() => import('./testing-view').then(m => ({ default: m.TestingView })));

type View = 'landing' | 'overview' | 'testing';

// Loading fallback component
function ViewLoader() {
  return (
    <div className="view-loader">
      <div className="loader-spinner" />
      <style>{`
        .view-loader {
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
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

  const handleStart = (prompt: string) => {
    setCurrentView('testing');
    console.log('Starting test generation with prompt:', prompt);
  };

  return (
    <div className="app-container">
      <Suspense fallback={<ViewLoader />}>
        {currentView === 'landing' && (
          <LandingPage onStart={handleStart} />
        )}
        
        {currentView === 'overview' && (
          <ProjectOverview />
        )}

        {currentView === 'testing' && (
          <TestingView />
        )}
      </Suspense>

      <style>{`
        .app-container {
          min-height: 100vh;
          background: #0a0a0a;
        }
      `}</style>
    </div>
  );
}

export default App;
