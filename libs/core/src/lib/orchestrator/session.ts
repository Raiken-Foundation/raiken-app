import type { DOMContext } from '../dom-capture';

export interface GeneratedTest {
  feature: string;
  path: string;
  timestamp: number;
}

export interface Session {
  capturedDOMs: Map<string, DOMContext>;
  generatedTests: GeneratedTest[];
  lastUsedUrl: string | null;
  lastUrl: string | null;
  currentGoal: string | null;
  lastAction: string | null;
  lastDomSummary: string | null;
  createdAt: number;
  lastActivityAt: number;
}

// In-memory session store (persists while server is running)
const sessions = new Map<string, Session>();

/**
 * Get or create a session for a project
 */
export function getOrCreateSession(projectPath: string): Session {
  if (!sessions.has(projectPath)) {
    sessions.set(projectPath, {
      capturedDOMs: new Map(),
      generatedTests: [],
      lastUsedUrl: null,
      lastUrl: null,
      currentGoal: null,
      lastAction: null,
      lastDomSummary: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    });
  }
  
  const session = sessions.get(projectPath)!;
  session.lastActivityAt = Date.now();
  return session;
}

/**
 * Get a cached DOM for a URL
 * Returns null if not cached or if cache is stale (older than 5 minutes)
 */
export function getCachedDOM(projectPath: string, url: string): DOMContext | null {
  const session = sessions.get(projectPath);
  if (!session) return null;
  
  const cached = session.capturedDOMs.get(url);
  if (!cached) return null;
  
  // Check if cache is stale (5 minutes)
  const CACHE_TTL = 5 * 60 * 1000;
  if (Date.now() - cached.timestamp > CACHE_TTL) {
    console.log(`🗑️ Cached DOM for ${url} is stale, removing`);
    session.capturedDOMs.delete(url);
    return null;
  }
  
  console.log(`✓ Using cached DOM for ${url}`);
  return cached;
}

/**
 * Cache a DOM for a URL
 */
export function cacheDOM(projectPath: string, url: string, dom: DOMContext): void {
  const session = getOrCreateSession(projectPath);
  session.capturedDOMs.set(url, dom);
  session.lastUsedUrl = url;
  session.lastUrl = url;
  console.log(`📦 Cached DOM for ${url}`);
}

/**
 * Get the last used URL for a session
 */
export function getLastUsedUrl(projectPath: string): string | null {
  const session = sessions.get(projectPath);
  return session?.lastUsedUrl ?? null;
}

export function setLastUrl(projectPath: string, url: string | null): void {
  const session = getOrCreateSession(projectPath);
  session.lastUrl = url;
  if (url) {
    session.lastUsedUrl = url;
  }
}

export function setCurrentGoal(projectPath: string, goal: string | null): void {
  const session = getOrCreateSession(projectPath);
  session.currentGoal = goal;
}

export function setLastAction(projectPath: string, action: string | null): void {
  const session = getOrCreateSession(projectPath);
  session.lastAction = action;
}

export function setLastDomSummary(projectPath: string, summary: string | null): void {
  const session = getOrCreateSession(projectPath);
  session.lastDomSummary = summary;
}

export function getSessionMemory(projectPath: string): {
  currentGoal: string | null;
  lastAction: string | null;
  lastDomSummary: string | null;
  lastUrl: string | null;
} {
  const session = sessions.get(projectPath);
  return {
    currentGoal: session?.currentGoal ?? null,
    lastAction: session?.lastAction ?? null,
    lastDomSummary: session?.lastDomSummary ?? null,
    lastUrl: session?.lastUrl ?? session?.lastUsedUrl ?? null,
  };
}

/**
 * Record a generated test
 */
export function recordGeneratedTest(projectPath: string, feature: string, testPath: string): void {
  const session = getOrCreateSession(projectPath);
  session.generatedTests.push({
    feature,
    path: testPath,
    timestamp: Date.now(),
  });
}

/**
 * Get all generated tests for a session
 */
export function getGeneratedTests(projectPath: string): GeneratedTest[] {
  const session = sessions.get(projectPath);
  return session?.generatedTests ?? [];
}

/**
 * Clear a session
 */
export function clearSession(projectPath: string): void {
  sessions.delete(projectPath);
  console.log(`🗑️ Cleared session for ${projectPath}`);
}

/**
 * Get session stats (for debugging)
 */
export function getSessionStats(projectPath: string): {
  exists: boolean;
  cachedDOMCount: number;
  generatedTestCount: number;
  lastUsedUrl: string | null;
  lastUrl: string | null;
  currentGoal: string | null;
  lastAction: string | null;
  lastDomSummary: string | null;
} {
  const session = sessions.get(projectPath);
  if (!session) {
    return {
      exists: false,
      cachedDOMCount: 0,
      generatedTestCount: 0,
      lastUsedUrl: null,
      lastUrl: null,
      currentGoal: null,
      lastAction: null,
      lastDomSummary: null,
    };
  }
  
  return {
    exists: true,
    cachedDOMCount: session.capturedDOMs.size,
    generatedTestCount: session.generatedTests.length,
    lastUsedUrl: session.lastUsedUrl,
    lastUrl: session.lastUrl,
    currentGoal: session.currentGoal,
    lastAction: session.lastAction,
    lastDomSummary: session.lastDomSummary,
  };
}
