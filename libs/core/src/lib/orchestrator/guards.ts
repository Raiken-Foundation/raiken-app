/**
 * Guard functions for XState Orchestrator
 * 
 * Guards are pure functions that return boolean to control transitions
 */

import type { OrchestratorContext } from './types';

/**
 * Check if we should retry DOM capture
 */
export function shouldRetry({ context }: { context: OrchestratorContext }): boolean {
  return context.retryCount < context.maxRetries;
}

/**
 * Check if intent is test generation
 */
export function isTestGeneration({ context }: { context: OrchestratorContext }): boolean {
  return context.intent === 'test-generation';
}

/**
 * Check if intent is chat
 */
export function isChat({ context }: { context: OrchestratorContext }): boolean {
  return context.intent === 'chat';
}

/**
 * Check if intent is help
 */
export function isHelp({ context }: { context: OrchestratorContext }): boolean {
  return context.intent === 'help';
}

/**
 * Check if page analysis matches user intent
 */
export function pageMatches({ context }: { context: OrchestratorContext }): boolean {
  return context.pageAnalysis?.matchesIntent ?? false;
}

/**
 * Check if page analysis allows proceeding (even if not perfect match)
 */
export function canProceed({ context }: { context: OrchestratorContext }): boolean {
  return context.pageAnalysis?.canProceed ?? false;
}

/**
 * Check if we have a URL to use
 */
export function hasUrl({ context }: { context: OrchestratorContext }): boolean {
  return context.appUrl !== null && context.appUrl.length > 0;
}

/**
 * Check if we have DOM context
 */
export function hasDom({ context }: { context: OrchestratorContext }): boolean {
  return context.domContext !== null;
}

/**
 * Check if we have resolved files
 */
export function hasFiles({ context }: { context: OrchestratorContext }): boolean {
  return context.resolvedFiles.length > 0;
}

/**
 * Check if there's an error
 */
export function hasError({ context }: { context: OrchestratorContext }): boolean {
  return context.error !== null;
}
