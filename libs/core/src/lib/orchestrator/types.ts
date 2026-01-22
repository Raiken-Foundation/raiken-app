/**
 * Types for XState Orchestrator
 */

import type { DOMContext } from '../dom-capture';

/**
 * Intent classification results
 */
export type Intent = 'test-generation' | 'chat' | 'help';

/**
 * Page state analysis results
 */
export interface PageStateAnalysis {
  matchesIntent: boolean;
  currentPageType: string;
  canProceed: boolean;
  reasoning: string;
}

/**
 * Configuration for AI calls
 */
export interface AIConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Input options for the orchestrator
 */
export interface OrchestratorInput {
  userPrompt: string;
  projectPath: string;
  conversationHistory?: Array<{ role: string; content: string }>;
  fileContext?: string[];
}

/**
 * Context for the XState machine
 */
export interface OrchestratorContext {
  // Input (per turn)
  userPrompt: string;
  conversationHistory: Array<{ role: string; content: string }>;
  projectPath: string;
  fileContext: string[];
  
  // AI Configuration
  config: AIConfig;
  
  // Extracted data
  resolvedFiles: string[];
  intent: Intent | null;
  metaIntent: 'stop' | 'go' | 'retry' | 'new' | 'clarify' | 'cancel' | 'continue' | 'refine' | null;
  nextTool: 'domCapture' | 'codeSearch' | 'testGen' | 'explain' | 'none' | null;
  appUrl: string | null;
  cancelRequested: boolean;
  
  // Session memory (persisted across turns)
  currentGoal: string | null;
  lastAction: string | null;
  lastDomSummary: string | null;
  lastUrl: string | null;
  
  // DOM capture
  domContext: DOMContext | null;
  pageAnalysis: PageStateAnalysis | null;
  
  // Retry tracking
  retryCount: number;
  maxRetries: number;
  
  // Error handling
  error: Error | null;
  errorMessage: string | null;
  
  // Output (will be set by streaming states)
  streamType: 'test' | 'chat' | 'error' | null;
}

/**
 * Events for the XState machine
 */
export type OrchestratorEvent =
  | { type: 'RECEIVE_MESSAGE'; input: OrchestratorInput }
  | { type: 'FILES_EXTRACTED'; files: string[] }
  | { type: 'INTENT_CLASSIFIED'; intent: Intent; files: string[] }
  | { type: 'URL_RESOLVED'; url: string }
  | { type: 'DOM_CAPTURED'; dom: DOMContext }
  | { type: 'DOM_FAILED'; error: Error }
  | { type: 'PAGE_ANALYZED'; analysis: PageStateAnalysis }
  | { type: 'STREAM_COMPLETE' }
  | { type: 'RESET' };
