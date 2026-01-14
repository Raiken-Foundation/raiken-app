import { useState, useEffect } from 'react';
import { Header } from '../components/header';
import { Sidebar } from '../components/sidebar';
import { CodeEditor, TestFile } from '../components/code-editor';
import { TestResults, TestResult, TestSummary } from '../components/test-results';
import { DatabaseViewer } from '../components/database-viewer';
import { trpc } from '../utils/trpc';

// Sample test results for display
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

const loadingStyles = `
  .loading-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-center;
    height: 100vh;
    gap: 1rem;
    color: #9ca3af;
  }

  .spinner {
    width: 40px;
    height: 40px;
    border: 3px solid #1f1f1f;
    border-top-color: #a855f7;
    border-radius: 50%;
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }
`;

export function TestingView() {
  const [activeFileId, setActiveFileId] = useState<string>('');
  const [files, setFiles] = useState<TestFile[]>([]);
  const [showDatabase, setShowDatabase] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [activeFilePath, setActiveFilePath] = useState<string>('');
  
  // Fetch project info
  const { data: projectInfo } = trpc.getProjectInfo.useQuery();
  
  // Fetch code graph stats
  const { data: statsData } = trpc.getGraphStats.useQuery({});
  
  // Build code graph mutation
  const buildGraphMutation = trpc.buildCodeGraph.useMutation({
    onSuccess: (data) => {
      console.log('✅ Code graph built:', data);
      setIsBuilding(false);
      // Refetch stats after building
      window.location.reload(); // Simple refresh to update everything
    },
    onError: (error) => {
      console.error('❌ Failed to build code graph:', error);
      setIsBuilding(false);
    },
  });
  
  // Fetch files from code graph
  const { data: graphFiles, isLoading: filesLoading } = trpc.getGraphFiles.useQuery(
    { limit: 100, offset: 0 },
    { enabled: (statsData?.totalFiles ?? 0) > 0 }
  );
  
  // Fetch file content when a file is selected
  const { data: fileContent, isLoading: contentLoading } = trpc.getFileContent.useQuery(
    { filePath: activeFilePath },
    { enabled: !!activeFilePath }
  );
  
  // Build graph on first load if no files exist
  useEffect(() => {
    if (statsData && statsData.totalFiles === 0 && !isBuilding) {
      console.log('📊 No files found, building code graph...');
      setIsBuilding(true);
      buildGraphMutation.mutate({ path: '.', persist: true });
    }
  }, [statsData]);
  
  // Convert graph files to TestFile format
  useEffect(() => {
    if (graphFiles?.files) {
      const convertedFiles: TestFile[] = graphFiles.files.map((file, index) => ({
        id: index.toString(),
        name: file.path.split('/').pop() || file.path,
        path: file.path,
        content: '', // Will be loaded separately when selected
        status: 'pending' as const,
        passedCount: 0,
        failedCount: 0,
      }));
      setFiles(convertedFiles);
      
      // Set first file as active if not already set
      if (convertedFiles.length > 0 && !activeFileId) {
        setActiveFileId(convertedFiles[0].id);
        setActiveFilePath(convertedFiles[0].path);
      }
    }
  }, [graphFiles]);
  
  // Update file content when loaded
  useEffect(() => {
    if (fileContent && activeFileId) {
      setFiles(prevFiles =>
        prevFiles.map(file =>
          file.id === activeFileId
            ? { ...file, content: fileContent.content }
            : file
        )
      );
    }
  }, [fileContent, activeFileId]);
  
  const activeFile = files.find(f => f.id === activeFileId);

  const handleHealSync = () => {
    console.log('🔄 Rebuilding code graph...');
    setIsBuilding(true);
    buildGraphMutation.mutate({ path: '.', persist: true });
  };

  const handleSendMessage = (message: string) => {
    console.log('💬 Message sent:', message);
    // TODO: Implement AI chat functionality
  };

  const handleContentChange = (fileId: string, content: string) => {
    setFiles(prevFiles => 
      prevFiles.map(file => 
        file.id === fileId ? { ...file, content } : file
      )
    );
  };
  
  const handleFileSelect = (fileId: string) => {
    setActiveFileId(fileId);
    const selectedFile = files.find(f => f.id === fileId);
    if (selectedFile) {
      setActiveFilePath(selectedFile.path);
    }
  };

  // Loading state
  if (filesLoading || isBuilding) {
    return (
      <div className="testing-view">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>{isBuilding ? 'Building code graph...' : 'Loading files...'}</p>
        </div>
        <style>{loadingStyles}</style>
        <style>{`
          .testing-view {
            display: flex;
            flex-direction: column;
            height: 100vh;
            background: #0a0a0a;
            overflow: hidden;
          }

          .loading-state {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            height: 100vh;
            gap: 1rem;
            color: #9ca3af;
          }

          .spinner {
            width: 40px;
            height: 40px;
            border: 3px solid #1f1f1f;
            border-top-color: #a855f7;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }

          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }
  
  // Show loading indicator in editor while content loads
  const displayFiles = files.map(file => 
    file.id === activeFileId && contentLoading
      ? { ...file, content: '// Loading file content...' }
      : file
  );

  return (
    <div className="testing-view">
      <Header 
        projectName={projectInfo?.path?.split('/').pop() || 'raiken-app'}
        staleCount={0}
        failedCount={0}
        userName="Developer"
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
              files={displayFiles}
              activeFileId={activeFileId}
              onFileSelect={handleFileSelect}
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

