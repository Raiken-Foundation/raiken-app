#!/usr/bin/env node
/**
 * Project Visualizer - Analyze and visualize a codebase
 * 
 * Usage: node tools/visualize-project.js <path>
 */

const path = require('path');
const fs = require('fs');

// Target project path
const targetPath = process.argv[2] || '/Users/Armand/Documents/Code/moni';

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  🔍 PROJECT VISUALIZER');
  console.log('═'.repeat(70));
  console.log(`\n📁 Analyzing: ${targetPath}\n`);

  try {
    const core = require('../dist/libs/core');
    const { CodeGraph, EntryPointDetector, CodeGraphDB, parseTypeScriptFile, summarizeParsedFile } = core;

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 1: ENTRY POINT DETECTION
    // ═══════════════════════════════════════════════════════════════════
    console.log('┌' + '─'.repeat(68) + '┐');
    console.log('│  🎯 PHASE 1: ENTRY POINT DETECTION' + ' '.repeat(32) + '│');
    console.log('└' + '─'.repeat(68) + '┘\n');

    const detector = new EntryPointDetector(targetPath);
    const entryPoints = await detector.detectEntryPoints();

    if (entryPoints.length > 0) {
      console.log(`Found ${entryPoints.length} entry points:\n`);
      entryPoints.forEach((ep, i) => {
        const relPath = path.relative(targetPath, ep.file);
        const icon = ep.framework ? '⚡' : '📄';
        console.log(`  ${icon} ${relPath}`);
        console.log(`     └─ Type: ${ep.type} | Framework: ${ep.framework || 'none'} | Role: ${ep.role || 'N/A'}`);
      });
    } else {
      console.log('  No explicit entry points found (will scan entire project)');
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2: CODE GRAPH BUILDING
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n┌' + '─'.repeat(68) + '┐');
    console.log('│  📊 PHASE 2: CODE GRAPH CONSTRUCTION' + ' '.repeat(30) + '│');
    console.log('└' + '─'.repeat(68) + '┘\n');

    const startTime = Date.now();
    const graph = new CodeGraph(targetPath, {
      includeTests: false,
      useGitignore: true,
      maxDepth: 20
    });

    // Use entry points if found, otherwise scan
    if (entryPoints.length > 0) {
      await graph.initialize(entryPoints.map(ep => ep.file));
    } else {
      await graph.scanProject();
    }

    const scanTime = Date.now() - startTime;
    const stats = graph.getStats();
    const allFiles = graph.getAllFiles();

    console.log(`✅ Graph built in ${scanTime}ms\n`);
    console.log('  ┌─────────────────────────────────────┐');
    console.log('  │          PROJECT STATISTICS         │');
    console.log('  ├─────────────────────────────────────┤');
    console.log(`  │  Total Files:     ${String(stats.totalFiles).padStart(15)} │`);
    
    const totalSize = allFiles.reduce((sum, n) => sum + (n.size || 0), 0);
    const totalLines = allFiles.reduce((sum, n) => sum + (n.lines || 0), 0);
    const totalFunctions = allFiles.reduce((sum, n) => sum + n.parsed.functions.length, 0);
    const totalClasses = allFiles.reduce((sum, n) => sum + n.parsed.classes.length, 0);
    const totalTypes = allFiles.reduce((sum, n) => sum + n.parsed.types.length, 0);
    const totalImports = allFiles.reduce((sum, n) => sum + n.parsed.imports.length, 0);
    const totalExports = allFiles.reduce((sum, n) => sum + n.parsed.exports.length, 0);

    console.log(`  │  Total Lines:     ${String(totalLines).padStart(15)} │`);
    console.log(`  │  Total Size:      ${formatBytes(totalSize).padStart(15)} │`);
    console.log('  ├─────────────────────────────────────┤');
    console.log(`  │  Functions:       ${String(totalFunctions).padStart(15)} │`);
    console.log(`  │  Classes:         ${String(totalClasses).padStart(15)} │`);
    console.log(`  │  Types/Interfaces:${String(totalTypes).padStart(15)} │`);
    console.log(`  │  Imports:         ${String(totalImports).padStart(15)} │`);
    console.log(`  │  Exports:         ${String(totalExports).padStart(15)} │`);
    console.log('  └─────────────────────────────────────┘');

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 3: DEPENDENCY GRAPH VISUALIZATION
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n┌' + '─'.repeat(68) + '┐');
    console.log('│  🔗 PHASE 3: DEPENDENCY GRAPH' + ' '.repeat(38) + '│');
    console.log('└' + '─'.repeat(68) + '┘\n');

    // Sort files by number of dependents (most imported first)
    const filesByDependents = [...allFiles]
      .filter(f => f.importedBy.length > 0)
      .sort((a, b) => b.importedBy.length - a.importedBy.length)
      .slice(0, 10);

    if (filesByDependents.length > 0) {
      console.log('  📥 Most Imported Files (Hub Files):\n');
      filesByDependents.forEach((file, i) => {
        const bar = '█'.repeat(Math.min(file.importedBy.length, 30));
        console.log(`  ${String(i + 1).padStart(2)}. ${file.relativePath}`);
        console.log(`      └─ ${bar} (${file.importedBy.length} dependents)`);
      });
    }

    // Files with most imports
    const filesByImports = [...allFiles]
      .filter(f => f.imports.length > 0)
      .sort((a, b) => b.imports.length - a.imports.length)
      .slice(0, 10);

    if (filesByImports.length > 0) {
      console.log('\n  📤 Files With Most Imports:\n');
      filesByImports.forEach((file, i) => {
        const bar = '▓'.repeat(Math.min(file.imports.length, 30));
        console.log(`  ${String(i + 1).padStart(2)}. ${file.relativePath}`);
        console.log(`      └─ ${bar} (${file.imports.length} imports)`);
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 4: AST ANALYSIS (Sample Files)
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n┌' + '─'.repeat(68) + '┐');
    console.log('│  🌳 PHASE 4: AST ANALYSIS (Sample Files)' + ' '.repeat(27) + '│');
    console.log('└' + '─'.repeat(68) + '┘\n');

    // Pick the most interesting files (largest, most functions, etc.)
    const interestingFiles = [...allFiles]
      .sort((a, b) => {
        const scoreA = a.parsed.functions.length + a.parsed.classes.length * 3 + a.parsed.types.length;
        const scoreB = b.parsed.functions.length + b.parsed.classes.length * 3 + b.parsed.types.length;
        return scoreB - scoreA;
      })
      .slice(0, 5);

    for (const file of interestingFiles) {
      console.log(`  📄 ${file.relativePath}`);
      console.log('  ' + '─'.repeat(50));
      
      // Functions
      if (file.parsed.functions.length > 0) {
        console.log('  Functions:');
        file.parsed.functions.slice(0, 5).forEach(fn => {
          const exported = fn.isExported ? '⬆️ ' : '  ';
          const async = fn.isAsync ? 'async ' : '';
          console.log(`    ${exported}${async}${fn.name}(${fn.params.slice(0, 3).join(', ')}${fn.params.length > 3 ? '...' : ''})`);
        });
        if (file.parsed.functions.length > 5) {
          console.log(`    ... and ${file.parsed.functions.length - 5} more`);
        }
      }
      
      // Classes
      if (file.parsed.classes.length > 0) {
        console.log('  Classes:');
        file.parsed.classes.forEach(cls => {
          const exported = cls.isExported ? '⬆️ ' : '  ';
          console.log(`    ${exported}class ${cls.name}`);
          if (cls.methods.length > 0) {
            console.log(`       └─ methods: ${cls.methods.slice(0, 5).join(', ')}${cls.methods.length > 5 ? '...' : ''}`);
          }
        });
      }
      
      // Types
      if (file.parsed.types.length > 0) {
        console.log('  Types:');
        file.parsed.types.slice(0, 5).forEach(type => {
          const exported = type.isExported ? '⬆️ ' : '  ';
          console.log(`    ${exported}${type.kind} ${type.name}`);
        });
        if (file.parsed.types.length > 5) {
          console.log(`    ... and ${file.parsed.types.length - 5} more`);
        }
      }
      
      // Imports summary
      if (file.parsed.imports.length > 0) {
        const externalImports = file.parsed.imports.filter(i => !i.source.startsWith('.'));
        const localImports = file.parsed.imports.filter(i => i.source.startsWith('.'));
        console.log(`  Imports: ${localImports.length} local, ${externalImports.length} external`);
      }
      
      // Exports summary
      if (file.parsed.exports.length > 0) {
        console.log(`  Exports: ${file.parsed.exports.slice(0, 5).join(', ')}${file.parsed.exports.length > 5 ? '...' : ''}`);
      }
      
      console.log('');
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 5: DATABASE PERSISTENCE
    // ═══════════════════════════════════════════════════════════════════
    console.log('┌' + '─'.repeat(68) + '┐');
    console.log('│  💾 PHASE 5: DATABASE PERSISTENCE' + ' '.repeat(33) + '│');
    console.log('└' + '─'.repeat(68) + '┘\n');

    const db = new CodeGraphDB(targetPath);
    
    const nodes = new Map();
    allFiles.forEach(f => nodes.set(f.filePath, f));
    
    const dbEntryPoints = entryPoints.map(ep => ({
      file: ep.file,
      framework: ep.framework,
      role: ep.role || 'main',
      type: ep.type
    }));

    const saveStart = Date.now();
    db.saveGraph(nodes, dbEntryPoints);
    const saveTime = Date.now() - saveStart;

    console.log(`  ✅ Saved to database in ${saveTime}ms`);
    
    const dbStats = db.getStats();
    const dbPath = path.join(targetPath, '.raiken', 'raiken.db');
    
    if (fs.existsSync(dbPath)) {
      const dbSize = fs.statSync(dbPath).size;
      console.log(`  📁 Database: ${dbPath}`);
      console.log(`  💾 Size: ${formatBytes(dbSize)}`);
    }

    db.close();

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 6: PROJECT STRUCTURE
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n┌' + '─'.repeat(68) + '┐');
    console.log('│  📂 PHASE 6: PROJECT STRUCTURE' + ' '.repeat(36) + '│');
    console.log('└' + '─'.repeat(68) + '┘\n');

    // Group files by directory
    const byDirectory = {};
    allFiles.forEach(file => {
      const dir = path.dirname(file.relativePath);
      if (!byDirectory[dir]) {
        byDirectory[dir] = [];
      }
      byDirectory[dir].push(file);
    });

    const sortedDirs = Object.keys(byDirectory).sort();
    
    console.log('  Directory breakdown:\n');
    sortedDirs.slice(0, 15).forEach(dir => {
      const files = byDirectory[dir];
      const totalFuncs = files.reduce((sum, f) => sum + f.parsed.functions.length, 0);
      const totalClasses = files.reduce((sum, f) => sum + f.parsed.classes.length, 0);
      
      const displayDir = dir || '(root)';
      console.log(`  📁 ${displayDir}/`);
      console.log(`     └─ ${files.length} files | ${totalFuncs} functions | ${totalClasses} classes`);
    });
    
    if (sortedDirs.length > 15) {
      console.log(`\n  ... and ${sortedDirs.length - 15} more directories`);
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 7: JSON EXPORT
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n┌' + '─'.repeat(68) + '┐');
    console.log('│  📄 PHASE 7: JSON EXPORT' + ' '.repeat(43) + '│');
    console.log('└' + '─'.repeat(68) + '┘\n');

    // Build JSON graph structure
    const graphJson = {
      meta: {
        projectPath: targetPath,
        analyzedAt: new Date().toISOString(),
        scanTimeMs: scanTime,
        version: '1.0'
      },
      stats: {
        totalFiles: stats.totalFiles,
        totalLines,
        totalSize,
        totalFunctions,
        totalClasses,
        totalTypes,
        totalImports,
        totalExports
      },
      entryPoints: entryPoints.map(ep => ({
        file: path.relative(targetPath, ep.file),
        type: ep.type,
        framework: ep.framework || null,
        role: ep.role || null,
        reason: ep.reason
      })),
      files: allFiles.map(file => ({
        path: file.relativePath,
        size: file.size,
        lines: file.lines,
        depth: file.depth,
        hash: file.hash,
        treeHash: file.treeHash,
        imports: file.imports.map(imp => path.relative(targetPath, imp)),
        importedBy: file.importedBy.map(imp => path.relative(targetPath, imp)),
        parsed: {
          functions: file.parsed.functions.map(fn => ({
            name: fn.name,
            params: fn.params,
            isAsync: fn.isAsync,
            isExported: fn.isExported,
            line: fn.line
          })),
          classes: file.parsed.classes.map(cls => ({
            name: cls.name,
            methods: cls.methods,
            properties: cls.properties,
            isExported: cls.isExported,
            line: cls.line
          })),
          types: file.parsed.types.map(type => ({
            name: type.name,
            kind: type.kind,
            isExported: type.isExported,
            line: type.line
          })),
          imports: file.parsed.imports.map(imp => ({
            source: imp.source,
            defaultImport: imp.defaultImport || null,
            namespaceImport: imp.namespaceImport || null,
            namedImports: imp.namedImports,
            isTypeOnly: imp.isTypeOnly || false
          })),
          exports: file.parsed.exports
        }
      })),
      dependencies: allFiles.flatMap(file => 
        file.imports.map(imp => ({
          source: file.relativePath,
          target: path.relative(targetPath, imp)
        }))
      )
    };

    // Save JSON file
    const jsonPath = path.join(targetPath, '.raiken', 'code-graph.json');
    fs.writeFileSync(jsonPath, JSON.stringify(graphJson, null, 2));
    
    console.log(`  ✅ JSON graph exported`);
    console.log(`  📄 File: ${jsonPath}`);
    console.log(`  💾 Size: ${formatBytes(fs.statSync(jsonPath).size)}`);

    // ═══════════════════════════════════════════════════════════════════
    // FINAL SUMMARY
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n' + '═'.repeat(70));
    console.log('  ✅ ANALYSIS COMPLETE');
    console.log('═'.repeat(70));
    console.log(`
  📊 Quick Stats:
     • ${stats.totalFiles} files analyzed
     • ${totalLines} lines of code
     • ${totalFunctions} functions
     • ${totalClasses} classes
     • ${totalTypes} types/interfaces
     • ${entryPoints.length} entry points
     • Built in ${scanTime}ms

  💾 Database: ${dbPath}
  📄 JSON Graph: ${jsonPath}
  
  🔍 Use these to explore further:
     • sqlite3 "${dbPath}" "SELECT * FROM files ORDER BY lines DESC LIMIT 10"
     • cat "${jsonPath}" | jq '.stats'
     • cat "${jsonPath}" | jq '.files[0]'
`);

  } catch (error) {
    console.error('\n❌ Analysis failed:');
    console.error(error);
    process.exit(1);
  }
}

function formatBytes(bytes) {
  if (bytes === 0 || !bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

main();

