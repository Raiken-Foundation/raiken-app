import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import ignore, { type Ignore } from 'ignore';
import { captureDOMContext, type DOMContext } from './dom-capture';
import { CodeGraphDB } from './db';

/**
 * DOM Capture Tool Options
 */
export interface CaptureDomToolOptions {
  storageStatePath?: string;
  timeout?: number;
}

/**
 * DOM Capture Tool
 * Captures the live DOM from a URL using Playwright's accessibility snapshot
 */
export async function captureDomTool(
  url: string, 
  options?: CaptureDomToolOptions
): Promise<{ context: DOMContext | null; message: string }> {
    try {
      if (options?.storageStatePath) {
        console.log(`🔐 Using storage state: ${options.storageStatePath}`);
      }
      const domContext = await captureDOMContext(url, options);
      return {
        context: domContext,
        message: `Captured DOM from ${url}: ${domContext.interactiveElements.length} interactive elements, ${domContext.formFields.length} form fields`
      };
    } catch (error) {
      console.error('❌ DOM capture failed:', error);
      return {
        context: null,
        message: `Failed to capture DOM: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
}

/**
 * Lookup files in the project by path pattern
 * This is exposed as a tool to the LLM
 */
export async function lookupFilesTool(projectPath: string, pattern: string): Promise<{ files: string[]; message: string }> {
    try {
      console.log(`📂 lookupFilesTool called with projectPath: ${projectPath}, pattern: ${pattern}`);
      
      // Filter files that match the pattern (case-insensitive)
      const normalizedPattern = pattern.toLowerCase().replace(/^@/, '').replace(/^\//, '');
      console.log(`📂 Normalized pattern: ${normalizedPattern}`);
      
      // First, search in code graph database
      const db = new CodeGraphDB(projectPath);
      const allFiles = db.getFiles();
      console.log(`📂 Total files in code graph: ${allFiles.length}`);
      
      if (allFiles.length > 0) {
        console.log(`📂 Sample files: ${allFiles.slice(0, 3).map(f => f.relative_path).join(', ')}`);
      }
      
      const matchingFiles = allFiles
        .filter(f => f.relative_path.toLowerCase().includes(normalizedPattern))
        .map(f => f.relative_path)
        .slice(0, 10); // Limit to 10 files
      
      console.log(`🔍 Code graph search for "${pattern}": found ${matchingFiles.length} matches`);
      if (matchingFiles.length > 0) {
        console.log(`🔍 Matching files: ${matchingFiles.join(', ')}`);
      }
      
      db.close();
      
      if (matchingFiles.length > 0) {
        return {
          files: matchingFiles,
          message: `Found ${matchingFiles.length} file(s) matching "${pattern}"`
        };
      }

      let ignoredHint = '';
      if (normalizedPattern) {
        const ignoreMatcher = await getIgnoreMatcher(projectPath);
        const normalizedPath = normalizedPattern.split(path.sep).join('/');
        if (ignoreMatcher.ignores(normalizedPath) || ignoreMatcher.ignores(`${normalizedPath}/`)) {
          ignoredHint = ' This path appears to be ignored by .gitignore.';
        }
      }

      return {
        files: [],
        message: `No files found matching "${pattern}".${ignoredHint} If the file exists but is ignored by .gitignore, it will not be indexed.`
      };
    } catch (error) {
      console.error('File lookup error:', error);
      return {
        files: [],
        message: `Error looking up files: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

async function getIgnoreMatcher(projectPath: string): Promise<Ignore> {
  const ignoreMatcher = ignore();
  const gitignorePath = path.join(projectPath, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    const lines = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    if (lines.length > 0) {
      ignoreMatcher.add(lines);
    }
  } catch {
    // No .gitignore or unreadable file
  }
  return ignoreMatcher;
}
  