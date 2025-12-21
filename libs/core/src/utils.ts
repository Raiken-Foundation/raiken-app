import * as t from '@babel/types';
import * as fs from 'fs/promises';

export function getParamName(param: any): string {
    if (t.isIdentifier(param)) {
        return param.name;
    } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
        return `...${param.argument.name}`;
    } else if (t.isObjectPattern(param)) {
        return '{ ... }';
    } else if (t.isArrayPattern(param)) {
        return '[ ... ]';
    }
    return 'param';
}

export function isExportedNode(path: any): boolean {
    let current = path;
    while (current) {
        if (t.isExportNamedDeclaration(current.node) ||
            t.isExportDefaultDeclaration(current.node)) {
            return true;
        }
        current = current.parentPath;
    }
    return false;
}

export async function countLines(filePath: string): Promise<number> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n').length;
  } catch {
    return 0;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

export function isTestDirectory(dirName: string): boolean {
  const testDirs = ['__tests__', '__test__', 'test', 'tests', 'spec', 'specs', 'e2e', 'cypress'];
  return testDirs.includes(dirName.toLowerCase());
}

export function isTestFile(fileName: string): boolean {
  return fileName.includes('.test.') || 
         fileName.includes('.spec.') || 
         fileName.includes('.e2e.');
}

export function shouldIgnoreDirectory(dirName: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    if (pattern === dirName || pattern === `/${dirName}` || dirName.startsWith(pattern + '/')) {
      return true;
    }
  }
  return false;
}

export function shouldIgnoreFile(fileName: string, relativePath: string, ignorePatterns: string[]): boolean {
  for (const pattern of ignorePatterns) {
    if (relativePath.includes(pattern) || fileName === pattern) {
      return true;
    }
  }
  return false;
}

