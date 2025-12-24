import { useState } from 'react';
import { Header } from '../components/header';
import { Sidebar } from '../components/sidebar';
import { CodeEditor, TestFile } from '../components/code-editor';
import { TestResults, TestResult, TestSummary } from '../components/test-results';
import { DatabaseViewer } from '../components/database-viewer';

// Sample data matching the Figma design
const sampleTestFiles: TestFile[] = [
  {
    id: '1',
    name: 'UserProfile.test.tsx',
    path: 'src/components/UserProfile.test.tsx',
    status: 'failed',
    passedCount: 8,
    failedCount: 1,
    content: `        name: 'Jane Doe',
        email: 'jane@example.com',
        role: 'Developer'
      };

      render(<UserProfile user={mockUser} onEdit={handleEdit} />);

      const editButton = screen.getByRole('button', { name: /edit/i });`
  },
  {
    id: '2',
    name: 'AuthService.test.tsx',
    path: 'src/services/AuthService.test.tsx',
    status: 'running',
    passedCount: 5,
    failedCount: 0,
    content: `describe('AuthService', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('should authenticate user with valid credentials', async () => {
    const result = await AuthService.login('user@test.com', 'password123');
    expect(result.success).toBe(true);
  });
});`
  },
  {
    id: '3',
    name: 'Dashboard.test.tsx',
    path: 'src/pages/Dashboard.test.tsx',
    status: 'pending',
    passedCount: 0,
    failedCount: 0,
    content: `import { render, screen } from '@testing-library/react';
import { Dashboard } from './Dashboard';

describe('Dashboard', () => {
  it('should render dashboard header', () => {
    render(<Dashboard />);
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });
});`
  }
];

const sampleTestResults: TestResult[] = [
  {
    id: '1',
    suite: 'UserProfile Component',
    name: 'should render user information correctly',
    status: 'passed',
    duration: 12
  },
  {
    id: '2',
    suite: 'UserProfile Component',
    name: 'should handle edit button click',
    status: 'failed',
    duration: 8,
    error: {
      expected: '1 call',
      received: '0 calls'
    }
  },
  {
    id: '3',
    suite: 'UserProfile Component',
    name: 'should display placeholder when user is null',
    status: 'passed',
    duration: 5
  }
];

const sampleSummary: TestSummary = {
  suites: {
    passed: 2,
    failed: 1,
    total: 3
  },
  tests: {
    passed: 8,
    failed: 1,
    total: 9
  },
  time: 1.323
};

export function TestingView() {
  const [activeFileId, setActiveFileId] = useState(sampleTestFiles[0].id);
  const [files, setFiles] = useState<TestFile[]>(sampleTestFiles);
  const [showDatabase, setShowDatabase] = useState(false);
  const activeFile = files.find(f => f.id === activeFileId);

  const handleHealSync = () => {
    console.log('Heal & Sync clicked');
    // TODO: Implement heal & sync functionality
  };

  const handleSendMessage = (message: string) => {
    console.log('Message sent:', message);
    // TODO: Implement AI chat functionality
  };

  const handleContentChange = (fileId: string, content: string) => {
    setFiles(prevFiles => 
      prevFiles.map(file => 
        file.id === fileId ? { ...file, content } : file
      )
    );
  };

  return (
    <div className="testing-view">
      <Header 
        projectName="raiken-demo-app"
        staleCount={1}
        failedCount={1}
        userName="Alex Chen"
        onHealSync={handleHealSync}
      />
      
      <div className="main-content">
        <Sidebar 
          onSendMessage={handleSendMessage}
          onDatabaseClick={() => setShowDatabase(!showDatabase)}
          showingDatabase={showDatabase}
        />
        
        {showDatabase ? (
          <DatabaseViewer onClose={() => setShowDatabase(false)} />
        ) : (
          <div className="editor-section">
            <CodeEditor 
              files={files}
              activeFileId={activeFileId}
              onFileSelect={setActiveFileId}
              onContentChange={handleContentChange}
            />
          </div>
        )}
      </div>

      {/* Test Results - Full Width at Bottom */}
      <TestResults 
        results={sampleTestResults}
        summary={sampleSummary}
        filePath={activeFile?.path}
      />

      <style>{`
        .testing-view {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background: #0a0a0a;
          overflow: hidden;
        }

        .main-content {
          flex: 1;
          display: flex;
          overflow: hidden;
          min-height: 0;
        }

        .editor-section {
          flex: 1;
          display: flex;
          flex-direction: column;
          overflow: hidden;
          min-height: 0;
        }
      `}</style>
    </div>
  );
}

