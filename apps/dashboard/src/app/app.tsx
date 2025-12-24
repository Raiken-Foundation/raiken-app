import { useState } from 'react';
import { LandingPage } from './landing-page';
import { ProjectOverview } from './project-overview';
import { TestingView } from './testing-view';

type View = 'landing' | 'overview' | 'testing';

export function App() {
  const [currentView, setCurrentView] = useState<View>('testing');

  const handleStart = (prompt: string) => {
    setCurrentView('testing');
    console.log('Starting test generation with prompt:', prompt);
  };

  return (
    <div className="app-container">
      {currentView === 'landing' && (
        <LandingPage onStart={handleStart} />
      )}
      
      {currentView === 'overview' && (
        <ProjectOverview />
      )}

      {currentView === 'testing' && (
        <TestingView />
      )}

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
