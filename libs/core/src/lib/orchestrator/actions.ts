import type { DOMContext } from '../dom-capture';
import { extractURLFromMessage } from '../../utils';
import {
  getCachedDOM,
  cacheDOM,
  getLastUsedUrl,
  setCurrentGoal,
  setLastAction,
  setLastDomSummary,
  setLastUrl,
} from './session';

/**
 * Extract URL from message or conversation history
 */
export function resolveUrl(
  userPrompt: string,
  conversationHistory: Array<{ role: string; content: string }>,
  projectPath: string
): string | null {
  // Try current message first
  let url = extractURLFromMessage(userPrompt);
  if (url) return url;
  
  // Try conversation history (most recent first)
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    url = extractURLFromMessage(conversationHistory[i].content);
    if (url) {
      console.log(`📍 Found URL in conversation history: ${url}`);
      return url;
    }
  }
  
  // Try session's last used URL
  const lastUrl = getLastUsedUrl(projectPath);
  if (lastUrl) {
    console.log(`📍 Using last used URL from session: ${lastUrl}`);
    return lastUrl;
  }
  
  return null;
}

/**
 * Check if DOM is already cached
 */
export function checkCachedDom(projectPath: string, url: string): DOMContext | null {
  return getCachedDOM(projectPath, url);
}

/**
 * Cache a DOM
 */
export function saveDomToCache(projectPath: string, url: string, dom: DOMContext): void {
  cacheDOM(projectPath, url, dom);
}

export function recordGoal(projectPath: string, goal: string | null): void {
  setCurrentGoal(projectPath, goal);
}

export function recordAction(projectPath: string, action: string | null): void {
  setLastAction(projectPath, action);
}

export function recordLastUrl(projectPath: string, url: string | null): void {
  setLastUrl(projectPath, url);
}

export function recordDomSummary(projectPath: string, dom: DOMContext | null): void {
  if (!dom) {
    setLastDomSummary(projectPath, null);
    return;
  }

  const summary = [
    `Title: ${dom.title}`,
    `URL: ${dom.url}`,
    `Interactive: ${dom.interactiveElements.length}`,
    `Fields: ${dom.formFields.length}`,
  ].join(' | ');

  setLastDomSummary(projectPath, summary);
}
