import { useState } from 'react';
import { LandingPage } from './landing-page';
import { ProjectOverview } from './project-overview';
import { TestingView } from './testing-view';

type View = 'landing' | 'overview' | 'testing';

export function App() {
  const [currentView, setCurrentView] = useState<View>('testing'); // Start with testing view for demo
  const [testPrompt, setTestPrompt] = useState('');

  const handleStart = (prompt: string) => {
    setTestPrompt(prompt);
    setCurrentView('testing');
    // TODO: Start the AI test generation flow
    console.log('Starting test generation with prompt:', prompt);
  };

  const handleBack = () => {
    setCurrentView('landing');
    setTestPrompt('');
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
