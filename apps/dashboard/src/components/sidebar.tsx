import { useState, useEffect, useRef } from 'react';
import Markdown from 'react-markdown';
import { FilesPanel, type TestFileItem } from './files-panel';
import { trpc } from '../utils/trpc';

interface Message {
  id: string;
  content: string;
  timestamp: string;
  isUser: boolean;
  isLoading?: boolean;
  fileMentions?: string[];
  hitlData?: HITLConfirmation;
}

// Human-in-the-loop confirmation data
interface HITLConfirmation {
  type: string;
  title: string;
  message: string;
  reasons: string[];
  options: Array<{
    id: string;
    label: string;
    description: string;
  }>;
  context: {
    url?: string;
    files?: string[];
  };
}

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  content: 'Welcome to Raiken AI! 👋\n\nI can help you generate tests for your code. Try:\n• "Generate a test for the LoginForm component"\n• "Write tests for the @src/utils.ts file"\n\nUse @ to mention specific files from your project.',
  timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
  isUser: false
};

interface SidebarProps {
  onSendMessage?: (message: string) => void;
  onFileSelect?: (filePath: string) => void;
  activeFilePath?: string;
}

export function Sidebar({ onSendMessage, onFileSelect, activeFilePath }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<'chat' | 'files' | 'settings'>('chat');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [_streamedContent, setStreamedContent] = useState('');
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [messagesLoaded, setMessagesLoaded] = useState(false);
  const [files, setFiles] = useState<TestFileItem[]>([]);
  const [sourceFiles, setSourceFiles] = useState<Array<{ path: string; name: string }>>([]);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompletePosition, setAutocompletePosition] = useState(0);
  const [filteredFiles, setFilteredFiles] = useState<Array<{ path: string; name: string }>>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  // Load persisted chat messages
  const { data: chatData } = trpc.getChatMessages.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  // Mutation to save messages
  const addMessageMutation = trpc.addChatMessage.useMutation();
  const clearMessagesMutation = trpc.clearChatMessages.useMutation();

  // Load messages from server on mount
  useEffect(() => {
    if (chatData?.messages && !messagesLoaded) {
      if (chatData.messages.length > 0) {
        // Convert server messages to local format
        const loadedMessages: Message[] = chatData.messages.map(msg => ({
          id: msg.id,
          content: msg.content,
          timestamp: new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
          isUser: msg.sender === 'user',
          fileMentions: msg.fileMentions,
        }));
        setMessages([WELCOME_MESSAGE, ...loadedMessages]);
      }
      setMessagesLoaded(true);
    }
  }, [chatData, messagesLoaded]);

  // Helper to persist a message to the server
  const persistMessage = (message: Message) => {
    addMessageMutation.mutate({
      id: message.id,
      content: message.content,
      sender: message.isUser ? 'user' : 'assistant',
      timestamp: Date.now(),
      fileMentions: message.fileMentions,
    });
  };

  // Clear chat handler
  const handleClearChat = () => {
    clearMessagesMutation.mutate(undefined, {
      onSuccess: () => {
        setMessages([WELCOME_MESSAGE]);
      },
    });
  };

  // Handle HITL (Human-in-the-Loop) button clicks
  const handleHITLAction = async (actionId: string, context: { url?: string; files?: string[] }) => {
    console.log(`🎯 HITL Action: ${actionId}`, context);
    
    // Send a special message that the backend will recognize
    const hitlMessage = `HITL_ACTION:${actionId}:${JSON.stringify(context)}`;
    
    // Add user action as a message
    const actionLabel = actionId === 'proceed' ? '✅ Proceed with test generation' : '❌ Cancel';
    const userMessage: Message = {
      id: Date.now().toString(),
      content: actionLabel,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      isUser: true
    };
    
    setMessages(prev => [...prev, userMessage]);
    setIsGenerating(true);
    
    // Add AI placeholder
    const aiMessageId = (Date.now() + 1).toString();
    const aiMessage: Message = {
      id: aiMessageId,
      content: '',
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      isUser: false,
      isLoading: true
    };
    setMessages(prev => [...prev, aiMessage]);
    
    try {
      const response = await fetch('/api/generate-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt: hitlMessage,
          fileContext: context.files || [],
          conversationHistory: messages.filter(m => m.id !== 'welcome').slice(-10).map(m => ({
            role: m.isUser ? 'user' : 'assistant',
            content: m.content
          }))
        })
      });
      
      if (!response.ok) {
        throw new Error('Failed to process action');
      }
      
      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';
      
      if (!reader) {
        throw new Error('No response body');
      }
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.chunk) {
                accumulated += data.chunk;
                setMessages(prev => prev.map(msg => 
                  msg.id === aiMessageId 
                    ? { ...msg, content: accumulated, isLoading: false }
                    : msg
                ));
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
      
      // Check if we should trigger save dialog
      const hasPlaywrightImport = accumulated.includes("import { test") && accumulated.includes("@playwright/test");
      const hasTestStructure = accumulated.includes('test.describe(') || 
                               (accumulated.includes('describe(') && accumulated.includes('test('));
      const hasMultipleTests = (accumulated.match(/\btest\s*\(/g) || []).length >= 2;
      
      if (hasPlaywrightImport && hasTestStructure && hasMultipleTests) {
        onSendMessage?.(accumulated);
      }
      
      // Persist the AI response
      persistMessage({
        id: aiMessageId,
        content: accumulated,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isUser: false
      });
      
    } catch (error) {
      console.error('HITL action failed:', error);
      setMessages(prev => prev.map(msg => 
        msg.id === aiMessageId 
          ? { ...msg, content: `Error: ${error instanceof Error ? error.message : 'Action failed'}`, isLoading: false }
          : msg
      ));
    } finally {
      setIsGenerating(false);
    }
  };

  // Fetch test files from filesystem (not from code graph)
  const { data: testFilesData, isLoading: filesLoading, refetch: refetchTestFiles } = trpc.listTestFiles.useQuery({});

  // Fetch ALL files for @ mentions (including both source and test files)
  const { data: allFilesData } = trpc.getGraphFiles.useQuery({
    limit: 1000,
    offset: 0
  });

  // Convert API files to TestFileItem format (for the Files panel)
  useEffect(() => {
    if (testFilesData?.files) {
      const convertedFiles: TestFileItem[] = testFilesData.files.map((file, index) => ({
        id: `test-${index}`,
        name: file.name,
        path: file.path,
        directory: file.directory,
        status: 'fresh' as const
      }));
      
      setFiles(convertedFiles);
    }
  }, [testFilesData]);

  // Process all files for @ mentions (include ALL files - both source and test files)
  useEffect(() => {
    if (allFilesData?.files && testFilesData?.files) {
      // Combine source files from code graph
      const sourceFilesFromGraph = allFilesData.files.map(file => ({
        path: file.path,
        name: file.path.split('/').pop() || file.path
      }));
      
      // Add test files from filesystem
      const testFilesForAutocomplete = testFilesData.files.map(file => ({
        path: file.path,
        name: file.name
      }));
      
      // Combine and deduplicate
      const allFiles = [...sourceFilesFromGraph, ...testFilesForAutocomplete];
      const uniqueFiles = Array.from(
        new Map(allFiles.map(f => [f.path, f])).values()
      );
      
      console.log(`📂 Loaded ${uniqueFiles.length} files for autocomplete (${sourceFilesFromGraph.length} source + ${testFilesForAutocomplete.length} test)`);
      setSourceFiles(uniqueFiles);
    }
  }, [allFilesData, testFilesData]);

  const checkAndShowAutocomplete = (value: string, cursorPos: number) => {
    console.log(`🔍 Autocomplete check: value="${value}", cursor=${cursorPos}, sourceFiles.length=${sourceFiles.length}`);
    
    const textBeforeCursor = value.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    
    if (lastAtIndex !== -1) {
      // Check if we're within an @ mention (no space after @)
      const afterAt = textBeforeCursor.slice(lastAtIndex + 1);
      const hasSpaceAfterAt = afterAt.includes(' ');
      
      console.log(`   @ found at index ${lastAtIndex}, afterAt="${afterAt}", hasSpace=${hasSpaceAfterAt}`);
      
      if (!hasSpaceAfterAt && cursorPos - lastAtIndex <= 50) { // Within 50 chars of @
        if (sourceFiles.length === 0) {
          console.warn('⚠️  No source files available for autocomplete');
          return;
        }
        
        if (lastAtIndex === cursorPos - 1) {
          // Just typed @, show all files
          console.log(`   ✓ Showing all ${sourceFiles.length} files`);
          setFilteredFiles(sourceFiles);
          setShowAutocomplete(true);
          setAutocompletePosition(0);
        } else {
          // Typing/positioned after @, filter files
          const searchTerm = afterAt;
          const filtered = sourceFiles.filter(file => 
            file.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            file.path.toLowerCase().includes(searchTerm.toLowerCase())
          );
          console.log(`   ✓ Filtered to ${filtered.length} files matching "${searchTerm}"`);
          setFilteredFiles(filtered);
          setShowAutocomplete(filtered.length > 0);
          setAutocompletePosition(0);
        }
      } else {
        console.log('   ✗ Outside @ mention range');
        setShowAutocomplete(false);
      }
    } else {
      console.log('   ✗ No @ found');
      setShowAutocomplete(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setInputValue(value);
    const cursorPos = e.target.selectionStart || 0;
    checkAndShowAutocomplete(value, cursorPos);
  };

  const handleInputClick = (e: React.MouseEvent<HTMLInputElement>) => {
    const cursorPos = (e.target as HTMLInputElement).selectionStart || 0;
    checkAndShowAutocomplete(inputValue, cursorPos);
  };

  // Copy code to clipboard
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Open code in editor as a new file
  const openCodeInEditor = (code: string, language: string) => {
    // Generate a temp file name based on language
    const ext = language === 'typescript' || language === 'ts' ? 'ts' 
      : language === 'javascript' || language === 'js' ? 'js'
      : language === 'tsx' ? 'tsx'
      : language === 'jsx' ? 'jsx'
      : language === 'python' ? 'py'
      : language === 'css' ? 'css'
      : language === 'html' ? 'html'
      : 'txt';
    const fileName = `scratch-${Date.now()}.${ext}`;
    // Store the code temporarily and open in editor
    sessionStorage.setItem(`scratch:${fileName}`, code);
    onFileSelect?.(`scratch:${fileName}`);
  };

  // Render message content with markdown support and @ mentions styled
  const renderMessageContent = (content: string, isUser = false) => {
    // For user messages, just style the @ mentions
    if (isUser) {
      const mentionRegex = /@([\w/.-]+)/g;
      const parts: React.ReactNode[] = [];
      let lastIndex = 0;
      let match;

      while ((match = mentionRegex.exec(content)) !== null) {
        if (match.index > lastIndex) {
          parts.push(content.substring(lastIndex, match.index));
        }
        parts.push(
          <span key={match.index} className="file-mention">
            @{match[1]}
          </span>
        );
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < content.length) {
        parts.push(content.substring(lastIndex));
      }

      return parts.length > 0 ? parts : content;
    }

    // For assistant messages, render as Markdown
    return (
      <Markdown
        components={{
          // Style code blocks
          code: ({ className, children, ...props }) => {
            const isInline = !className;
            return isInline ? (
              <code className="inline-code" {...props}>{children}</code>
            ) : (
              <code className={`code-block ${className || ''}`} {...props}>{children}</code>
            );
          },
          // Style pre blocks with copy/open buttons
          pre: ({ children }: { children?: React.ReactNode }) => {
            const codeElement = children as React.ReactElement<{ className?: string }>;
            const langClass = codeElement?.props?.className || '';
            const language = langClass.replace('language-', '').replace('code-block ', '');
            const [copied, setCopied] = useState(false);
            const preRef = useRef<HTMLPreElement>(null);

            const getCodeContent = () => preRef.current?.textContent || '';

            const handleCopy = () => {
              copyToClipboard(getCodeContent());
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            };

            return (
              <div className="code-block-wrapper">
                <div className="code-block-header">
                  <span className="code-lang">{language || 'code'}</span>
                  <div className="code-block-actions">
                    <button 
                      type="button"
                      className="code-action-btn"
                      onClick={handleCopy}
                      title="Copy code"
                    >
                      {copied ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                        </svg>
                      )}
                    </button>
                    <button 
                      type="button"
                      className="code-action-btn"
                      onClick={() => openCodeInEditor(getCodeContent(), language)}
                      title="Open in editor"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
                        <polyline points="15 3 21 3 21 9" />
                        <line x1="10" y1="14" x2="21" y2="3" />
                      </svg>
                    </button>
                  </div>
                </div>
                <pre ref={preRef} className="code-pre">{children}</pre>
              </div>
            );
          },
          // Style links
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="md-link">{children}</a>
          ),
          // Style lists
          ul: ({ children }) => <ul className="md-list">{children}</ul>,
          ol: ({ children }) => <ol className="md-list md-list-ordered">{children}</ol>,
          li: ({ children }) => <li className="md-list-item">{children}</li>,
          // Style headings
          h1: ({ children }) => <h1 className="md-heading md-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="md-heading md-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="md-heading md-h3">{children}</h3>,
          // Style blockquotes
          blockquote: ({ children }) => <blockquote className="md-blockquote">{children}</blockquote>,
          // Style tables
          table: ({ children }) => <table className="md-table">{children}</table>,
          th: ({ children }) => <th className="md-th">{children}</th>,
          td: ({ children }) => <td className="md-td">{children}</td>,
        }}
      >
        {content}
      </Markdown>
    );
  };

  const selectFile = (file: { path: string; name: string }, event?: React.MouseEvent | React.KeyboardEvent) => {
    // Prevent any default behavior that might trigger form submission
    event?.preventDefault();
    event?.stopPropagation();
    
    const cursorPos = inputRef.current?.selectionStart || 0;
    const textBeforeCursor = inputValue.slice(0, cursorPos);
    const lastAtIndex = textBeforeCursor.lastIndexOf('@');
    
    if (lastAtIndex !== -1) {
      const beforeAt = inputValue.slice(0, lastAtIndex);
      const afterCursor = inputValue.slice(cursorPos);
      const newValue = `${beforeAt}@${file.path} ${afterCursor}`;
      setInputValue(newValue);
      setShowAutocomplete(false);
      
      // Set focus back to input with a slight delay to ensure autocomplete closes first
      setTimeout(() => {
        inputRef.current?.focus();
        // Position cursor after the inserted file path
        const newCursorPos = lastAtIndex + file.path.length + 2; // +2 for @ and space
        inputRef.current?.setSelectionRange(newCursorPos, newCursorPos);
      }, 10);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showAutocomplete) return;
    
    if (e.key === 'ArrowDown') {
    e.preventDefault();
      setAutocompletePosition(prev => Math.min(prev + 1, filteredFiles.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAutocompletePosition(prev => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && showAutocomplete && filteredFiles.length > 0) {
      // When autocomplete is showing, Enter selects from autocomplete, NOT submit form
      e.preventDefault();
      e.stopPropagation();
      selectFile(filteredFiles[autocompletePosition], e);
    } else if (e.key === 'Escape') {
      setShowAutocomplete(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim() || isGenerating) return;
    
    // Extract mentioned files from current prompt
    const mentionRegex = /@([^\s]+)/g;
    const matches = [...inputValue.matchAll(mentionRegex)];
    const newFileContext = matches.map(match => match[1]);
    
    // Build conversation history (exclude welcome message, limit to last 10 messages for context)
    const conversationHistory = messages
      .filter(msg => msg.id !== 'welcome')
      .slice(-10)
      .map(msg => ({
        role: msg.isUser ? 'user' : 'assistant',
        content: msg.content
      }));
    
    // Extract all files mentioned in conversation history
    const historicalFiles = new Set<string>();
    messages.forEach(msg => {
      const msgMatches = [...msg.content.matchAll(mentionRegex)];
      msgMatches.forEach(match => historicalFiles.add(match[1]));
    });
    
    // Combine new files with historical files (deduplicate)
    const allFileContext = [...new Set([...newFileContext, ...Array.from(historicalFiles)])];
    
    const userMessage: Message = {
      id: Date.now().toString(),
      content: inputValue,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      isUser: true,
      fileMentions: newFileContext.length > 0 ? newFileContext : undefined
    };
    
    setMessages(prev => [...prev, userMessage]);
    persistMessage(userMessage); // Save to server
    const prompt = inputValue;
    setInputValue('');
    setIsGenerating(true);
    setStreamedContent('');

    // Add AI placeholder message with loading state
    const aiMessageId = (Date.now() + 1).toString();
    const aiMessage: Message = {
      id: aiMessageId,
      content: '',
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
      isUser: false,
      isLoading: true
    };
    setMessages(prev => [...prev, aiMessage]);

    try {
      console.log('🔍 Sending request to /api/generate-test');
      console.log('Prompt:', prompt);
      console.log('File context:', allFileContext);
      console.log('Conversation history:', conversationHistory.length, 'messages');
      
      const response = await fetch('/api/generate-test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          prompt,
          fileContext: allFileContext, // Send all mentioned files
          conversationHistory // Send conversation history for context
        })
      });
      
      console.log('📥 Response status:', response.status);
      console.log('📥 Response headers:', response.headers);

      if (!response.ok) {
        throw new Error('Failed to generate test');
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulated = '';

      if (!reader) {
        throw new Error('No response body');
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              
              if (data.error) {
                throw new Error(data.error);
              }
              
              if (data.chunk) {
                accumulated += data.chunk;
                setStreamedContent(accumulated);
                console.log('📦 Received chunk, total length:', accumulated.length);
                
                // Check for HITL marker
                const hitlMatch = accumulated.match(/<!--HITL:(.+?)-->/);
                let hitlData: HITLConfirmation | undefined;
                let displayContent = accumulated;
                
                if (hitlMatch) {
                  try {
                    hitlData = JSON.parse(hitlMatch[1]);
                    // Remove the HITL marker from display content
                    displayContent = '';
                  } catch (e) {
                    console.warn('Failed to parse HITL data:', e);
                  }
                }
                
                // Update AI message with accumulated content and remove loading state
                setMessages(prev => prev.map(msg => 
                  msg.id === aiMessageId 
                    ? { ...msg, content: displayContent, isLoading: false, hitlData }
                    : msg
                ));
              }
              
              if (data.done) {
                console.log('✓ Test generation complete');
              }
            } catch (_parseError) {
              // Ignore JSON parse errors for incomplete chunks
            }
          }
        }
      }

      // Persist the AI response
      const finalAiMessage: Message = {
        id: aiMessageId,
        content: accumulated,
        timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        isUser: false
      };
      persistMessage(finalAiMessage);

      // Only notify parent if this is a complete test file (not just a snippet or confirmation prompt)
      // Must have BOTH import and test structure, and NOT be a HITL confirmation
      const hasPlaywrightImport = accumulated.includes("import { test") && accumulated.includes("@playwright/test");
      const hasTestStructure = accumulated.includes('test.describe(') || 
                               (accumulated.includes('describe(') && accumulated.includes('test('));
      const hasMultipleTests = (accumulated.match(/\btest\s*\(/g) || []).length >= 2;
      const isHITLConfirmation = accumulated.includes('<!--HITL:');
      
      const isCompleteTestFile = hasPlaywrightImport && hasTestStructure && hasMultipleTests && !isHITLConfirmation;
      
      if (isCompleteTestFile) {
        console.log('✓ Detected complete test file, notifying parent');
        onSendMessage?.(accumulated);
      } else {
        console.log('ℹ️ Not a complete test file, skipping save dialog');
        console.log(`  - hasPlaywrightImport: ${hasPlaywrightImport}`);
        console.log(`  - hasTestStructure: ${hasTestStructure}`);
        console.log(`  - hasMultipleTests: ${hasMultipleTests}`);
        console.log(`  - isHITLConfirmation: ${isHITLConfirmation}`);
      }
    } catch (error) {
      console.error('Test generation failed:', error);
      
      // Update AI message with error and remove loading state
      setMessages(prev => prev.map(msg => 
        msg.id === aiMessageId 
          ? { ...msg, content: `Error: ${error instanceof Error ? error.message : 'Failed to generate test'}`, isLoading: false }
          : msg
      ));
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Navigation Icons */}
      <nav className="sidebar-nav">
        <button 
          className={`nav-btn ${activeTab === 'chat' ? 'active' : ''}`}
          onClick={() => { setActiveTab('chat'); if (isCollapsed) setIsCollapsed(false); }}
        >
          {/* Rounded rectangle chat bubble */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="4" y="4" width="16" height="14" rx="3" />
            <path d="M8 9h8M8 13h5" />
          </svg>
        </button>
        <button 
          className={`nav-btn ${activeTab === 'files' ? 'active' : ''}`}
          onClick={() => { setActiveTab('files'); if (isCollapsed) setIsCollapsed(false); }}
        >
          {/* Folder icon */}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
        </button>
        <button 
          className={`nav-btn settings ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => { setActiveTab('settings'); if (isCollapsed) setIsCollapsed(false); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>

        {/* Collapse Toggle */}
        <button 
          className="nav-btn collapse-btn"
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d={isCollapsed ? "M9 5l7 7-7 7" : "M15 19l-7-7 7-7"} />
          </svg>
        </button>
      </nav>

      {/* Content Panels - Hidden when collapsed */}
      {!isCollapsed && (
        <>
          {/* Chat Panel */}
          {activeTab === 'chat' && (
            <div className="chat-panel">
              {/* AI Agent Header */}
              <div className="agent-header">
                <div className="agent-icon">
                  <svg viewBox="5 2 14 14" fill="none">
                    <path 
                      d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" 
                      stroke="currentColor" 
                      strokeWidth="1.5" 
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
                <div className="agent-info">
                  <span className="agent-title">AI Agent</span>
                  <span className="agent-status">
                    <span className={`status-dot ${isGenerating ? 'generating' : ''}`} />
                    {isGenerating ? 'Generating...' : 'Ready'}
                  </span>
                </div>
                <button 
                  className="clear-chat-btn"
                  onClick={handleClearChat}
                  title="Clear chat history"
                  disabled={messages.length <= 1}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>

              {/* Messages */}
              <div className="messages">
                {messages.map((msg) => (
                  <div key={msg.id} className={`message ${msg.isUser ? 'user' : 'assistant'}`}>
                    <div className="message-bubble">
                      {msg.isLoading ? (
                        <div className="typing-indicator">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                      ) : msg.hitlData ? (
                        // Human-in-the-loop confirmation UI
                        <div className="hitl-confirmation">
                          <div className="hitl-header">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <span>{msg.hitlData.title}</span>
                          </div>
                          <p className="hitl-message">{msg.hitlData.message}</p>
                          {msg.hitlData.reasons.length > 0 && (
                            <ul className="hitl-reasons">
                              {msg.hitlData.reasons.map((reason, i) => (
                                <li key={i}>{reason}</li>
                              ))}
                            </ul>
                          )}
                          <div className="hitl-actions">
                            {msg.hitlData.options.map((option) => (
                              <button
                                key={option.id}
                                className={`hitl-btn ${option.id === 'proceed' ? 'primary' : 'secondary'}`}
                                onClick={() => handleHITLAction(option.id, msg.hitlData?.context ?? {})}
                                disabled={isGenerating}
                              >
                                {option.id === 'proceed' ? (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M5 13l4 4L19 7" />
                                  </svg>
                                ) : (
                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                )}
                                <span>{option.label}</span>
                              </button>
                            ))}
                          </div>
                          <p className="hitl-hint">
                            {msg.hitlData.options.find(o => o.id === 'proceed')?.description}
                          </p>
                        </div>
                      ) : (
                        renderMessageContent(msg.content, msg.isUser)
                      )}
                    </div>
                    <span className="message-time">{msg.timestamp}</span>
                  </div>
                ))}
              </div>

              {/* Input */}
              <form className="chat-input-container" onSubmit={handleSubmit}>
                {/* Autocomplete Dropdown */}
                {showAutocomplete && (
                  <div className="autocomplete-dropdown">
                    {filteredFiles.map((file, index) => (
                      <button
                        key={file.path}
                        type="button"
                        className={`autocomplete-item ${index === autocompletePosition ? 'active' : ''}`}
                        onClick={(e) => selectFile(file, e)}
                        onMouseEnter={() => setAutocompletePosition(index)}
                      >
                        <svg className="file-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                          <path d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        <div className="file-info">
                          <span className="file-name">{file.name}</span>
                          <span className="file-path">{file.path}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                
                <input
                  ref={inputRef}
                  type="text"
                  className="chat-input"
                  placeholder={isGenerating ? "Generating test..." : "Write a test for..."}
                  value={inputValue}
                  onChange={handleInputChange}
                  onClick={handleInputClick}
                  onKeyDown={handleKeyDown}
                  disabled={isGenerating}
                />
                <button type="submit" className="send-btn" disabled={isGenerating}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
                  </svg>
                </button>
              </form>
            </div>
          )}

          {/* Files Panel */}
          {activeTab === 'files' && (
            filesLoading ? (
                <div className="loading-panel">
                  <div className="loading-spinner"></div>
                  <span>Loading files...</span>
                </div>
              ) : (
            <FilesPanel 
                  files={files}
              activeFilePath={activeFilePath}
              onFileSelect={onFileSelect}
            />
              )
          )}

          {/* Settings Panel */}
          {activeTab === 'settings' && (
            <div className="settings-panel">
              <span className="settings-title">Settings</span>
              <span className="settings-subtitle">Coming soon...</span>
            </div>
          )}
        </>
      )}

      <style>{`
        .sidebar {
          display: flex;
          width: 100%;
          background: #0f0f0f;
          border-right: 1px solid #1f1f1f;
          transition: width 0.2s ease;
        }

        .sidebar.collapsed {
          width: 56px;
        }

        .sidebar.collapsed .sidebar-nav {
          border-right: none;
        }

        .sidebar-nav {
          display: flex;
          flex-direction: column;
          width: 56px;
          padding: 0.75rem 0.5rem;
          gap: 0.25rem;
          border-right: 1px solid #1f1f1f;
          flex-shrink: 0;
        }

        .nav-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          background: transparent;
          border: none;
          border-radius: 4px;
          color: #6b7280;
          cursor: pointer;
          transition: all 0.15s;
        }

        .nav-btn:hover {
          background: #1f1f1f;
          color: #9ca3af;
        }

        .nav-btn.active {
          background: #1f1f1f;
          color: #3b82f6;
        }

        .nav-btn.settings {
          margin-top: auto;
        }

        .nav-btn.collapse-btn {
          margin-top: 0.5rem;
        }

        .nav-btn.collapse-btn:hover {
          color: #e5e7eb;
        }

        .nav-btn svg {
          width: 1.25rem;
          height: 1.25rem;
        }

        .chat-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          padding: 1rem;
          gap: 1rem;
          background: linear-gradient(180deg, rgba(30, 58, 95, 0.3) 0%, rgba(15, 15, 15, 0) 50%);
          min-width: 0;
          overflow: hidden;
        }

        .settings-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 1rem;
        }

        .settings-title {
          font-size: 0.875rem;
          font-weight: 500;
          color: #e5e7eb;
        }

        .settings-subtitle {
          font-size: 0.75rem;
          color: #6b7280;
        }

        .agent-header {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding-bottom: 1rem;
          border-bottom: 1px solid #1f1f1f;
        }

        .clear-chat-btn {
          margin-left: auto;
          padding: 0.375rem;
          background: transparent;
          border: 1px solid #27272a;
          border-radius: 6px;
          color: #6b7280;
          cursor: pointer;
          transition: all 0.15s;
        }

        .clear-chat-btn:hover:not(:disabled) {
          background: #27272a;
          color: #ef4444;
          border-color: #ef4444;
        }

        .clear-chat-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .clear-chat-btn svg {
          width: 0.875rem;
          height: 0.875rem;
          display: block;
        }

        .agent-icon {
          width: 2.5rem;
          height: 2.5rem;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #1e3a5f 0%, #1e1e3f 100%);
          border-radius: 0.75rem;
          color: #60a5fa;
        }

        .agent-icon svg {
          width: 1.25rem;
          height: 1.25rem;
          display: block;
          flex-shrink: 0;
        }

        .agent-info {
          display: flex;
          flex-direction: column;
        }

        .agent-title {
          font-size: 0.875rem;
          font-weight: 500;
          color: #e5e7eb;
        }

        .agent-status {
          display: flex;
          align-items: center;
          gap: 0.375rem;
          font-size: 0.75rem;
          color: #6b7280;
        }

        .agent-status .status-dot {
          width: 6px;
          height: 6px;
          background: #22c55e;
          border-radius: 50%;
        }

        .agent-status .status-dot.generating {
          background: #f59e0b;
          animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite;
        }

        @keyframes pulse {
          0%, 100% {
            opacity: 1;
          }
          50% {
            opacity: 0.5;
          }
        }

        .messages {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 1rem;
          overflow-y: auto;
          overflow-x: hidden;
          padding-right: 0.5rem;
          min-width: 0;
        }

        .message {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 0.25rem;
          min-width: 0;
          max-width: 100%;
        }

        .message.assistant {
          align-items: flex-start;
        }

        .message-bubble {
          max-width: 85%;
          min-width: 0;
          padding: 0.625rem 0.875rem;
          background: #2563eb;
          border-radius: 1rem;
          font-size: 0.875rem;
          color: #ffffff;
          word-wrap: break-word;
          overflow-wrap: break-word;
          hyphens: auto;
        }

        .message.assistant .message-bubble {
          background: #1f1f1f;
          color: #e5e7eb;
        }

        /* Markdown Styles */
        .message.assistant .message-bubble p {
          margin: 0 0 0.5rem 0;
        }

        .message.assistant .message-bubble p:last-child {
          margin-bottom: 0;
        }

        .inline-code {
          background: rgba(99, 102, 241, 0.2);
          padding: 0.125rem 0.375rem;
          border-radius: 0.25rem;
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 0.8rem;
          color: #a5b4fc;
        }

        .code-block-wrapper {
          margin: 0.5rem 0;
          border-radius: 0.5rem;
          overflow: hidden;
          border: 1px solid #2a2a2a;
          max-width: 100%;
          min-width: 0;
        }

        .code-block-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.375rem 0.75rem;
          background: #1a1a1a;
          border-bottom: 1px solid #2a2a2a;
        }

        .code-lang {
          font-size: 0.6875rem;
          font-weight: 500;
          color: #6b7280;
          text-transform: uppercase;
          letter-spacing: 0.025em;
        }

        .code-block-actions {
          display: flex;
          gap: 0.25rem;
        }

        .code-action-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.5rem;
          height: 1.5rem;
          padding: 0;
          background: transparent;
          border: none;
          border-radius: 0.25rem;
          color: #6b7280;
          cursor: pointer;
          transition: all 0.15s;
        }

        .code-action-btn:hover {
          background: #2a2a2a;
          color: #e5e7eb;
        }

        .code-action-btn svg {
          width: 0.875rem;
          height: 0.875rem;
        }

        .code-pre {
          background: #0d0d0d;
          padding: 0.75rem 1rem;
          margin: 0;
          overflow-x: auto;
          overflow-y: auto;
          max-height: 300px;
        }

        .code-block-wrapper .code-pre {
          border-radius: 0;
          border: none;
        }

        .code-block {
          font-family: 'JetBrains Mono', 'Fira Code', monospace;
          font-size: 0.8rem;
          color: #e5e7eb;
          white-space: pre;
        }

        .md-link {
          color: #60a5fa;
          text-decoration: underline;
        }

        .md-link:hover {
          color: #93c5fd;
        }

        .md-list {
          margin: 0.5rem 0;
          padding-left: 1.25rem;
        }

        .md-list-ordered {
          list-style-type: decimal;
        }

        .md-list-item {
          margin: 0.25rem 0;
        }

        .md-heading {
          margin: 0.75rem 0 0.5rem 0;
          font-weight: 600;
          color: #f3f4f6;
        }

        .md-h1 {
          font-size: 1.25rem;
          border-bottom: 1px solid #3a3a3a;
          padding-bottom: 0.25rem;
        }

        .md-h2 {
          font-size: 1.1rem;
        }

        .md-h3 {
          font-size: 1rem;
        }

        .md-blockquote {
          border-left: 3px solid #4f46e5;
          padding-left: 0.75rem;
          margin: 0.5rem 0;
          color: #9ca3af;
          font-style: italic;
        }

        .md-table {
          width: 100%;
          border-collapse: collapse;
          margin: 0.5rem 0;
          font-size: 0.85rem;
        }

        .md-th, .md-td {
          border: 1px solid #3a3a3a;
          padding: 0.375rem 0.5rem;
          text-align: left;
        }

        .md-th {
          background: #1a1a1a;
          font-weight: 600;
        }

        .file-mention {
          display: inline-block;
          padding: 0.125rem 0.5rem;
          background: rgba(59, 130, 246, 0.2);
          border: 1px solid rgba(59, 130, 246, 0.3);
          border-radius: 0.375rem;
          color: #60a5fa;
          font-weight: 500;
          font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
          font-size: 0.8125rem;
          max-width: 100%;
          overflow-wrap: break-word;
          word-break: break-all;
        }

        .message.assistant .file-mention {
          background: rgba(59, 130, 246, 0.15);
          color: #93c5fd;
        }
        
        /* File mention styling in chat input */
        .chat-input-container .file-mention-input {
          display: inline;
          padding: 0.125rem 0.375rem;
          background: rgba(59, 130, 246, 0.25);
          border: 1px solid rgba(59, 130, 246, 0.4);
          border-radius: 0.25rem;
          color: #60a5fa;
          font-weight: 500;
          font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
          font-size: 0.8125rem;
        }

        .message-time {
          font-size: 0.625rem;
          color: #6b7280;
        }

        .chat-input-container {
          position: relative;
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem;
          background: #1a1a1a;
          border: 1px solid #2a2a2a;
          border-radius: 0.75rem;
        }

        .autocomplete-dropdown {
          position: absolute;
          bottom: 100%;
          left: 0;
          right: 0;
          margin-bottom: 0.5rem;
          max-height: 16rem;
          overflow-y: auto;
          background: #1a1a1a;
          border: 1px solid #2a2a2a;
          border-radius: 0.5rem;
          box-shadow: 0 -4px 6px -1px rgba(0, 0, 0, 0.3);
          z-index: 50;
        }

        .autocomplete-item {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.625rem 0.875rem;
          width: 100%;
          background: transparent;
          border: none;
          border-bottom: 1px solid #2a2a2a;
          text-align: left;
          cursor: pointer;
          transition: background 0.15s;
        }

        .autocomplete-item:last-child {
          border-bottom: none;
        }

        .autocomplete-item:hover,
        .autocomplete-item.active {
          background: #2a2a2a;
        }

        .autocomplete-item .file-icon {
          width: 1.125rem;
          height: 1.125rem;
          color: #6b7280;
          flex-shrink: 0;
        }

        .autocomplete-item .file-info {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 0.125rem;
          min-width: 0;
        }

        .autocomplete-item .file-name {
          font-size: 0.875rem;
          color: #e5e7eb;
          font-weight: 500;
        }

        .autocomplete-item .file-path {
          font-size: 0.75rem;
          color: #6b7280;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .chat-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #e5e7eb;
          font-size: 0.875rem;
          min-width: 0;
          z-index: 1;
        }

        .chat-input::placeholder {
          color: #4b5563;
        }

        .chat-input:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .send-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 2rem;
          height: 2rem;
          background: transparent;
          border: none;
          color: #6b7280;
          cursor: pointer;
          border-radius: 0.375rem;
          transition: all 0.15s;
        }

        .send-btn:hover:not(:disabled) {
          background: #2a2a2a;
          color: #9ca3af;
        }

        .send-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .send-btn svg {
          width: 1rem;
          height: 1rem;
        }

        .typing-indicator {
          display: flex;
          gap: 0.25rem;
          padding: 0.5rem 0;
          align-items: center;
        }

        .typing-indicator span {
          width: 8px;
          height: 8px;
          background: #6b7280;
          border-radius: 50%;
          animation: typing 1.4s infinite;
        }

        .typing-indicator span:nth-child(2) {
          animation-delay: 0.2s;
        }

        .typing-indicator span:nth-child(3) {
          animation-delay: 0.4s;
        }

        @keyframes typing {
          0%, 60%, 100% { 
            transform: translateY(0);
            opacity: 0.7;
          }
          30% { 
            transform: translateY(-6px);
            opacity: 1;
          }
        }

        .loading-panel {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 1rem;
          padding: 2rem;
          color: #6b7280;
          font-size: 0.875rem;
        }

        .loading-spinner {
          width: 2rem;
          height: 2rem;
          border: 2px solid #1f1f1f;
          border-top-color: #3b82f6;
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* Human-in-the-Loop Confirmation UI */
        .hitl-confirmation {
          padding: 1rem;
          background: linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, rgba(245, 158, 11, 0.05) 100%);
          border: 1px solid rgba(251, 191, 36, 0.3);
          border-radius: 0.75rem;
        }

        .hitl-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          margin-bottom: 0.75rem;
          color: #fbbf24;
          font-weight: 600;
          font-size: 0.9rem;
        }

        .hitl-header svg {
          width: 1.25rem;
          height: 1.25rem;
          flex-shrink: 0;
        }

        .hitl-message {
          color: #d1d5db;
          font-size: 0.875rem;
          margin: 0 0 0.75rem 0;
          line-height: 1.5;
        }

        .hitl-reasons {
          margin: 0 0 1rem 0;
          padding-left: 1.25rem;
          color: #9ca3af;
          font-size: 0.8rem;
          line-height: 1.6;
        }

        .hitl-reasons li {
          margin-bottom: 0.25rem;
        }

        .hitl-actions {
          display: flex;
          gap: 0.75rem;
          margin-bottom: 0.75rem;
        }

        .hitl-btn {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 0.625rem 1rem;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          border: 1px solid transparent;
        }

        .hitl-btn svg {
          width: 1rem;
          height: 1rem;
        }

        .hitl-btn.primary {
          background: linear-gradient(135deg, #10b981 0%, #059669 100%);
          color: white;
          border-color: #059669;
        }

        .hitl-btn.primary:hover:not(:disabled) {
          background: linear-gradient(135deg, #059669 0%, #047857 100%);
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(16, 185, 129, 0.3);
        }

        .hitl-btn.secondary {
          background: rgba(75, 85, 99, 0.3);
          color: #9ca3af;
          border-color: #4b5563;
        }

        .hitl-btn.secondary:hover:not(:disabled) {
          background: rgba(75, 85, 99, 0.5);
          color: #e5e7eb;
        }

        .hitl-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
          transform: none !important;
          box-shadow: none !important;
        }

        .hitl-hint {
          margin: 0;
          font-size: 0.75rem;
          color: #6b7280;
          font-style: italic;
        }
      `}</style>
    </aside>
  );
}

