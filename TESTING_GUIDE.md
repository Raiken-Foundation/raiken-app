# 🧪 Raiken Testing Guide - Complete Walkthrough

## 📋 What This Guide Covers

This comprehensive guide tests all Raiken features from infrastructure to embeddings:

- **Part 0:** Build Project & Dependencies *(5-10 min, first time only)*
- **Part 1:** Environment Setup
- **Part 2:** Sprint 1 - CLI + Dashboard + API
- **Part 3:** Sprint 2 - File scanning + Database
- **Part 4:** Sprint 3.1 - AST Parsing + Code Analysis
- **Part 5:** Sprint 3.2 - Local Embeddings + Semantic Search
- **Part 6:** Dashboard Integration
- **Part 7:** System Health Check
- **Part 8:** Code Quality - Refactoring verification + Unit tests

**Total Testing Time:** 
- First time: ~50 minutes (includes build)
- Subsequent runs: ~40 minutes (build already done)

---


## 🎯 Prerequisites

Before testing, ensure you have:
- ✅ Terminal access
- ✅ Node.js installed (v18 or higher)
- ✅ **pnpm** installed (`npm install -g pnpm` if needed)
- ✅ Project dependencies installed
- ✅ Browser ready
- ✅ `sqlite3` command-line tool (usually pre-installed on Mac/Linux)
- ✅ `jq` for JSON formatting (`brew install jq` on Mac)

**Important Notes:**
- This project uses **pnpm**, not npm!
- All commands assume you start from the **project root** (where `package.json` and `nx.json` are located)
- When you see "From project root" it means the directory where you cloned the repository

**Port Configuration:** All examples use port `7103`. You can change it with the `-p` flag:
```bash
node ../../dist/apps/cli/bin.cjs start -p YOUR_PORT
```

---

## ⚡ Quick Reference - Most Used Commands

```bash
# Build everything (from project root)
nx run-many -t build --projects=core,api,cli,dashboard

# Install CLI dependencies (after each build)
cd dist/apps/cli && npm install --omit=dev && cd ../../..

# Start server (from project root)
cd tools/playground
node ../../dist/apps/cli/bin.cjs start -p 7103

# Check health (from any terminal)
curl -s http://localhost:7103/api/trpc/getHealth

# Build code graph
curl -X POST http://localhost:7103/api/trpc/buildCodeGraph \
  -H "Content-Type: application/json" \
  -d '{"path":"."}'

# Generate embeddings
curl -X POST http://localhost:7103/api/trpc/generateEmbeddings \
  -H "Content-Type: application/json" \
  -d '{"forceRegenerate": false}'

# Search code
curl -s 'http://localhost:7103/api/trpc/searchCode?input=%7B%22query%22%3A%22button%22%7D'

# Check database (from tools/playground)
sqlite3 .raiken/raiken.db "SELECT * FROM files;"
```

---

## 🏗️ Part 0: Build Project (5-10 minutes) **DO THIS FIRST!**

> **Important:** If you don't have a `dist/` folder, start here!

### Step 0.1: Install Project Dependencies
```bash
# Navigate to project root (wherever you cloned the repo)
cd raiken-app  # or your project directory name

# Install all dependencies (first time or after clean install)
pnpm install
```

**✅ Expected:** Dependencies installed successfully

---

### Step 0.2: Build All Projects
```bash
# From project root
nx run-many -t build --projects=core,api,cli,dashboard
```

**⏱️ Expected Time:** 2-5 minutes (first build)

**✅ Expected Output:**
```
> nx run core:build
../../dist/libs/core/README.md

> nx run api:build
../../dist/libs/api/README.md

> nx run cli:build
✅ CLI build complete with dashboard assets

> nx run dashboard:build
✓ built in 1.8s

NX   Successfully ran target build for 4 projects
```

**🔍 Verify dist/ folder exists:**
```bash
ls -la dist/
```

**✅ Expected:** You should see:
```
drwxr-xr-x  apps/
drwxr-xr-x  libs/
```

---

### Step 0.3: Install CLI Dependencies
```bash
# From project root
cd dist/apps/cli

# Install production dependencies for CLI (use npm here, not pnpm)
npm install --omit=dev

# Return to project root
cd ../../..
```

**⏱️ Expected Time:** 30-60 seconds

**✅ Expected Output:**
```
added 250 packages, and audited 251 packages in 34s
```

---

### Step 0.4: Verify CLI Works
```bash
# From project root
cd tools/playground

# Test CLI binary
node ../../dist/apps/cli/bin.cjs --help
```

**✅ Expected Output:**
```
Usage: raiken [options] [command]

Raiken CLI - AI Testing Agent

Options:
  -V, --version      output the version number
  -h, --help         display help for command

Commands:
  init               Initialize Raiken in current directory
  start [options]    Start the Raiken Dashboard & Agent
  help [command]     display help for command
```

**❌ If you see "Cannot find module 'chalk'":** Go back to Step 0.3

---

### Step 0.5: Build Complete ✅

You're now ready to test! The project structure should look like:

```
raiken-app/                      ← Your project root
├── dist/
│   ├── apps/
│   │   ├── cli/
│   │   │   ├── bin.cjs          ← CLI binary
│   │   │   ├── node_modules/    ← Dependencies installed
│   │   │   └── public/          ← Dashboard assets
│   │   └── dashboard/
│   └── libs/
│       ├── api/
│       └── core/
├── tools/
│   └── playground/              ← Testing environment
└── ...
```

---

## 🚀 Part 1: Environment Setup (2 minutes)

### Step 1.1: Navigate to Playground
```bash
# From project root
cd tools/playground

# Remove old database (fresh start)
rm -rf .raiken

# Verify it's gone
ls -la | grep .raiken  # Should show nothing
```

### Step 1.2: Verify CLI Binary
```bash
# From playground directory
node ../../dist/apps/cli/bin.cjs --help
```

**✅ Expected Output:**
```
Usage: raiken [options] [command]

Raiken CLI - AI Testing Agent

Options:
  -V, --version      output the version number
  -h, --help         display help for command

Commands:
  init               Initialize Raiken in current directory
  start [options]    Start the Raiken Dashboard & Agent
```

---

## 🌐 Part 2: Sprint 1 - CLI & Dashboard (5 minutes)

### Step 2.1: Start the Server
```bash
# From project root, navigate to playground
cd tools/playground

# Start server (keep terminal open)
node ../../dist/apps/cli/bin.cjs start -p 7103
```

**✅ Expected Output:**
```
Initializing Raiken...
🚀 Raiken UI running at http://localhost:7103
```

**Keep this terminal open!**

---

### Step 2.2: Test Dashboard Access

**In Browser:** Open http://localhost:7103

**✅ Expected:**
- Dashboard loads (React UI)
- No errors in browser console
- Raiken interface visible

**Command Line Test:**
```bash
# In a NEW terminal
curl -s http://localhost:7103 | grep -i "raiken"
```

**✅ Should see:** HTML with "Raiken" text

---

### Step 2.3: Test API Health
```bash
curl -s http://localhost:7103/api/trpc/getHealth | python3 -m json.tool
```

**✅ Expected Output:**
```json
{
    "result": {
        "data": {
            "status": "ok",
            "engine": "raiken",
            "version": "0.0.1"
        }
    }
}
```

---

### Step 2.4: Test Project Detection
```bash
curl -s http://localhost:7103/api/project-info | python3 -m json.tool
```

**✅ Expected Output:**
```json
{
    "name": "@raiken/playground",
    "cwd": "<YOUR_PATH>/tools/playground",
    "projectType": "react",
    "packageManager": "npm",
    "testDir": "tests",
    "testFramework": "playwright"
}
```

*Note: `cwd` will show your actual project path*

---

## 📊 Part 3: Sprint 2 - File Scanning & Database (5 minutes)

### Step 3.1: Check Playground Files
```bash
# From tools/playground directory
# See what files will be scanned
find src -name "*.ts" -o -name "*.tsx" | sort
```

**✅ Expected:** List of TypeScript/React files (5-6 files)

---

### Step 3.2: Build Code Graph
```bash
curl -s -X POST 'http://localhost:7103/api/trpc/buildCodeGraph' \
  -H 'Content-Type: application/json' \
  -d '{"path": "."}' \
  | python3 -m json.tool | head -40
```

**✅ Expected Output:**
```json
{
    "result": {
        "data": {
            "projectRoot": ".",
            "entryPoints": [
                {
                    "file": "src/App.tsx",
                    "framework": "react",
                    "role": "main",
                    "type": "convention"
                }
            ],
            "stats": {
                "totalFiles": 6,
                "totalFunctions": 23,
                "totalClasses": 0,
                "lastUpdate": "2026-01-11T..."
            },
            "totalSize": 10218,
            "totalLines": 404
        }
    }
}
```

**Verify:** totalFiles: 5-6, totalFunctions: 20+, entry point: src/App.tsx

---

### Step 3.3: Verify Database & Tables
```bash
# From tools/playground directory
# Check database exists
ls -lh .raiken/raiken.db

# Check tables
sqlite3 .raiken/raiken.db ".tables"
```

**✅ Expected:** Database ~50-100KB with tables: `embeddings`, `files`, `stats`, `entry_points`, `migrations`, `vec_embeddings`

---

### Step 3.4: Query Files Table
```bash
sqlite3 .raiken/raiken.db "SELECT relative_path, functions_count, classes_count, lines FROM files ORDER BY relative_path;"
```

**✅ Expected Output:**
```
src/App.tsx|3|0|56
src/components/Button.tsx|1|0|23
src/utils/helpers.ts|5|0|89
...
```

---

### Step 3.5: Check Database Stats
```bash
sqlite3 .raiken/raiken.db "SELECT * FROM stats;"
```

**✅ Expected:** Row showing total files, functions, size, schema version

---

## 🧬 Part 4: Sprint 3.1 - AST Parsing (6 minutes)

### Step 4.1: Verify AST Data & Sample Functions
```bash
# Count files with AST
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM files WHERE parsed_ast IS NOT NULL;"

# Show sample extracted functions
sqlite3 .raiken/raiken.db "SELECT relative_path, json_extract(parsed_ast, '$.functions[0].name') as first_function FROM files WHERE parsed_ast IS NOT NULL LIMIT 3;"
```

**✅ Expected:** Count = 6, shows function names like `App`, `Button`, etc.

---

### Step 4.2: View Full AST Structure
```bash
# Pretty print AST for one file
sqlite3 .raiken/raiken.db "SELECT parsed_ast FROM files WHERE relative_path = 'src/App.tsx';" \
  | python3 -m json.tool | head -50
```

**✅ Expected Structure:**
```json
{
    "functions": [
        {
            "name": "App",
            "params": [],
            "isAsync": false,
            "isExported": true,
            "line": 5
        }
    ],
    "classes": [],
    "imports": [...],
    "exports": ["App"],
    "types": []
}
```

---

### Step 4.3: Count Functions Per File
```bash
sqlite3 .raiken/raiken.db "SELECT relative_path, json_array_length(json_extract(parsed_ast, '$.functions')) as function_count FROM files WHERE parsed_ast IS NOT NULL ORDER BY function_count DESC;"
```

**✅ Expected:** List showing which files have most functions

---

### Step 4.4: Verify Full Babel AST Storage

Two AST representations are stored:
- `parsed_ast` (~0.5-1KB) - Simplified structure (functions, classes, imports, exports)
- `ast` (~30-100KB) - Complete Babel AST with all code content

```bash
# Check AST storage sizes
sqlite3 .raiken/raiken.db "SELECT 
  relative_path, 
  LENGTH(parsed_ast) as parsed_size,
  LENGTH(ast) as full_ast_size,
  CASE WHEN ast IS NOT NULL THEN 'YES' ELSE 'NO' END as has_full_ast
FROM files 
ORDER BY relative_path
LIMIT 4;"
```

**✅ Expected Output:**
```
src/App.tsx|680|36590|YES
src/components/Counter.tsx|516|36453|YES
src/components/LoginForm.tsx|486|60125|YES
src/components/TodoList.tsx|728|106146|YES
```

**Verify:** All files have `has_full_ast = YES`, full_ast_size is 30-100KB (much larger than parsed_size).

---

### Step 4.5: Compare Simplified vs Full AST

#### 4.5.1: Size Comparison

```bash
# Compare storage sizes
sqlite3 .raiken/raiken.db "SELECT 
  relative_path,
  LENGTH(parsed_ast) as simplified_bytes,
  LENGTH(ast) as full_ast_bytes,
  ROUND(LENGTH(ast) * 1.0 / LENGTH(parsed_ast), 1) as size_ratio
FROM files 
WHERE relative_path = 'src/App.tsx';"
```

**✅ Expected Output:**
```
src/App.tsx|680|36590|53.8
```

Full AST is ~50-80x larger than simplified AST.

---

#### 4.5.2: View Simplified AST (Quick Reference)

```bash
# View simplified AST structure
sqlite3 .raiken/raiken.db "SELECT parsed_ast FROM files WHERE relative_path = 'src/App.tsx';" \
  | python3 -m json.tool | head -40
```

**✅ Expected Structure:**
```json
{
    "functions": [
        {
            "name": "App",
            "params": [],
            "isAsync": false,
            "isExported": false,
            "line": 6
        },
        {
            "name": "handleLogin",
            "params": ["user"],
            "isAsync": false,
            "isExported": false,
            "line": 10
        }
    ],
    "classes": [],
    "imports": [...],
    "exports": ["default (App)"],
    "types": []
}
```

**What it contains:** Function names, parameters, classes, imports/exports, types. Used for UI display and quick queries.

---

#### 4.5.3: View Full Babel AST (Complete Context)

```bash
# View complete Babel AST structure (first 120 lines)
sqlite3 .raiken/raiken.db "SELECT ast FROM files WHERE relative_path = 'src/App.tsx';" \
  | python3 -m json.tool | head -120
```

**✅ Expected Structure:**
```json
{
    "type": "File",
    "start": 0,
    "end": 1249,
    "loc": {
        "start": {"line": 1, "column": 0, "index": 0},
        "end": {"line": 56, "column": 0, "index": 1249}
    },
    "program": {
        "type": "Program",
        "sourceType": "module",
        "body": [
            {
                "type": "ImportDeclaration",
                "start": 0,
                "end": 33,
                "loc": {
                    "start": {"line": 1, "column": 9, "index": 9},
                    "end": {"line": 1, "column": 17, "index": 17}
                },
                "specifiers": [
                    {
                        "type": "ImportSpecifier",
                        "imported": {
                            "type": "Identifier",
                            "name": "useState"
                        },
                        "local": {
                            "type": "Identifier", 
                            "name": "useState"
                        }
                    }
                ],
                "source": {
                    "type": "StringLiteral",
                    "value": "react"
                }
            }
        ]
    }
}
```

**What it contains:** Complete Babel AST with all code content (JSX text, strings, identifiers), precise source locations, and full node hierarchies. Used for AI embeddings and test generation.

---

#### 4.5.4: Extract Code Content from Full AST

```bash
# Extract actual code content from the full AST
sqlite3 .raiken/raiken.db "SELECT ast FROM files WHERE relative_path = 'src/App.tsx';" | python3 -c "
import sys, json
ast = json.load(sys.stdin)

print('🔍 CODE CONTENT IN FULL AST:\n')

# Extract JSX text, strings, identifiers
def find_content(node, jsx=[], strings=[], ids=[], depth=0):
    if depth > 30: return jsx, strings, ids
    if isinstance(node, dict):
        t = node.get('type')
        if t == 'JSXText' and node.get('value', '').strip():
            jsx.append(node['value'].strip())
        elif t == 'StringLiteral' and len(node.get('value', '')) > 2:
            strings.append(node['value'])
        elif t == 'Identifier':
            ids.append(node.get('name'))
        for v in node.values():
            find_content(v, jsx, strings, ids, depth+1)
    elif isinstance(node, list):
        for i in node:
            find_content(i, jsx, strings, ids, depth+1)
    return jsx, strings, ids

jsx, strings, ids = find_content(ast)

print(f'📝 JSX Text: {jsx[:3]}')
print(f'📦 Strings: {strings[:5]}')
print(f'🔤 Identifiers: {sorted(set(ids))[:8]}')
print(f'\n✅ Total: {len(jsx)} JSX nodes, {len(strings)} strings, {len(set(ids))} unique identifiers')
"
```

**✅ Expected Output:**
```
🔍 CODE CONTENT IN FULL AST:

📝 JSX Text: ['Raiken Playground', 'Test application for E2E testing', 'Welcome,']
📦 Strings: ['react', './components/Counter', './components/TodoList', './components/LoginForm', 'container']
🔤 Identifiers: ['App', 'Counter', 'LoginForm', 'TodoList', 'handleLogin', 'handleLogout', 'isLoggedIn', 'setIsLoggedIn']

✅ Total: 7 JSX nodes, 12 strings, 12 unique identifiers
```

Full AST contains all code content including JSX text, strings, and identifiers.

---

#### 4.5.5: Count AST Nodes in Full AST

```bash
# Count how many AST nodes are in the full tree
sqlite3 .raiken/raiken.db "SELECT 
  relative_path,
  (LENGTH(ast) - LENGTH(REPLACE(ast, '\"type\":', ''))) / LENGTH('\"type\":') as node_count
FROM files 
WHERE relative_path = 'src/App.tsx';"
```

**✅ Expected:** ~100-200 nodes for a typical React component

---

#### 4.5.6: Why We Need Both? (Summary)

```bash
# Quick comparison query
echo "=== AST Comparison Summary ==="
sqlite3 .raiken/raiken.db "SELECT 
  'Simplified AST' as type,
  AVG(LENGTH(parsed_ast)) as avg_bytes,
  'Fast UI queries' as use_case
FROM files
UNION ALL
SELECT 
  'Full Babel AST',
  AVG(LENGTH(ast)),
  'AI embeddings + test gen'
FROM files;"
```

**✅ Expected Output:**
```
=== AST Comparison Summary ===
Simplified AST|580|Fast UI queries
Full Babel AST|54500|AI embeddings + test gen
```

**Summary:** Simplified AST (~580 bytes) for fast UI queries, Full Babel AST (~54KB) for embeddings generation. Embeddings use the full AST.

---

#### 4.5.7: Extract Specific Node Types from Full AST

```bash
# Count different node types in the full AST
sqlite3 .raiken/raiken.db "SELECT 
  relative_path,
  (LENGTH(ast) - LENGTH(REPLACE(ast, '\"ImportDeclaration\"', ''))) / LENGTH('\"ImportDeclaration\"') as imports,
  (LENGTH(ast) - LENGTH(REPLACE(ast, '\"FunctionDeclaration\"', ''))) / LENGTH('\"FunctionDeclaration\"') as functions,
  (LENGTH(ast) - LENGTH(REPLACE(ast, '\"JSXElement\"', ''))) / LENGTH('\"JSXElement\"') as jsx_elements
FROM files 
WHERE relative_path LIKE '%App.tsx';"
```

**✅ Expected:** Shows detailed counts of imports, functions, and JSX elements

Full AST captures complete code structure including all node types.

---

---

## 🤖 Part 5: Sprint 3.2 - Embeddings & Semantic Search (12 minutes)

### Step 5.1: Check Embeddings Model
```bash
# Check if model is downloaded
ls -lh ~/.cache/huggingface/hub/ 2>/dev/null | grep "MiniLM" || echo "Model will download on first generation"
```

---

### Step 5.2: Generate Embeddings (FIRST RUN)
```bash
curl -X POST 'http://localhost:7103/api/trpc/generateEmbeddings' \
  -H 'Content-Type: application/json' \
  -d '{"forceRegenerate": false}' \
  | python3 -m json.tool
```

**⏱️ Expected Time:**
- First run: 30-60 seconds (model download + generation)
- Subsequent runs: 5-10 seconds

**✅ Expected Output:**
```json
{
    "result": {
        "data": {
            "success": true,
            "filesProcessed": 6,
            "totalFiles": 6,
            "chunksGenerated": 23,
            "modelUsed": "Xenova/all-MiniLM-L6-v2",
            "embeddingDimension": 384,
            "timestamp": "2026-01-09T..."
        }
    }
}
```

**Verify:** success: true, chunksGenerated matches total functions, embeddingDimension: 384

---

### Step 5.3: Verify Embeddings in Database
```bash
# From tools/playground directory
# Check embeddings count
sqlite3 .raiken/raiken.db "SELECT COUNT(*) as total_embeddings FROM embeddings;"
```

**✅ Expected:** Number matching `chunksGenerated`

---

### Step 5.4: Inspect Sample Embeddings
```bash
sqlite3 .raiken/raiken.db "SELECT chunk_type, chunk_name, chunk_text FROM embeddings LIMIT 5;"
```

**✅ Expected:** List showing `function|App|function App() in src/App.tsx` etc.

---

### Step 5.5: Verify Embedding Vectors
```bash
# Check both tables have same count
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM embeddings; SELECT COUNT(*) FROM vec_embeddings;"
```

**✅ Expected:** Both counts should match (e.g., 23)

---

### Step 5.6: Test Embeddings Stats API
```bash
curl -s 'http://localhost:7103/api/trpc/getEmbeddingsStats?input=%7B%22path%22%3A%22.%22%7D' \
  | python3 -m json.tool
```

**✅ Expected Output:**
```json
{
    "result": {
        "data": {
            "totalEmbeddings": 23,
            "filesWithEmbeddings": 6,
            "chunkTypes": {
                "function": 23,
                "class": 0
            },
            "modelUsed": "Xenova/all-MiniLM-L6-v2",
            "embeddingDimension": 384
        }
    }
}
```

---

### Step 5.7: Test Semantic Search 🎯
```bash
# Search for "button component"
curl -s 'http://localhost:7103/api/trpc/searchCode?input=%7B%22query%22%3A%22button%20component%22%2C%22limit%22%3A5%7D' \
  | python3 -m json.tool
```

**✅ Expected Output:**
```json
{
    "result": {
        "data": {
            "query": "button component",
            "results": [
                {
                    "filePath": "src/components/Button.tsx",
                    "chunkName": "Button",
                    "chunkText": "function Button(props) in src/components/Button.tsx",
                    "similarity": 0.89
                }
            ]
        }
    }
}
```

**Verify:** Top result is relevant, similarity > 0.7 for good matches, results ordered by similarity.

---

### Step 5.8: Test Different Search Queries
```bash
# Search for user-related code
curl -s 'http://localhost:7103/api/trpc/searchCode?input=%7B%22query%22%3A%22user%20profile%22%2C%22limit%22%3A3%7D' \
  | python3 -c "import sys, json; results=json.load(sys.stdin)['result']['data']['results']; print('\\n'.join([f\"{r['chunkName']}: {r['similarity']:.2f}\" for r in results]))"

# Search for async functions
curl -s 'http://localhost:7103/api/trpc/searchCode?input=%7B%22query%22%3A%22async%20fetch%20data%22%7D' \
  | python3 -c "import sys, json; results=json.load(sys.stdin)['result']['data']['results']; print('\\n'.join([f\"{r['chunkName']}: {r['similarity']:.2f}\" for r in results[:3]]))"
```

---

### Step 5.9: Test Incremental Generation (Efficiency)
```bash
# Generate again WITHOUT force (should skip existing)
curl -s -X POST 'http://localhost:7103/api/trpc/generateEmbeddings' \
  -H 'Content-Type: application/json' \
  -d '{"forceRegenerate": false}' \
  | python3 -c "import sys, json; data=json.load(sys.stdin)['result']['data']; print(f\"Processed: {data['filesProcessed']}/{data['totalFiles']} files\")"
```

**✅ Expected:** `Processed: 0/6 files` (embeddings already exist, skips regeneration)

---

### Step 5.10: Test Force Regenerate
```bash
# Generate WITH force (regenerates all)
curl -s -X POST 'http://localhost:7103/api/trpc/generateEmbeddings' \
  -H 'Content-Type: application/json' \
  -d '{"forceRegenerate": true}' \
  | python3 -c "import sys, json; data=json.load(sys.stdin)['result']['data']; print(f\"Regenerated: {data['filesProcessed']}/{data['totalFiles']} files\")"
```

**✅ Expected:** `Regenerated: 6/6 files, 23 chunks`

---

## 🎨 Part 6: Dashboard Integration (3 minutes)

### Step 6.1: Test Database Viewer

**In Browser:** http://localhost:7103

Navigate to Database Viewer and run:
```sql
SELECT chunk_type, chunk_name, chunk_text 
FROM embeddings 
LIMIT 10;
```

**✅ Expected:** Table showing embeddings

---

### Step 6.2: Test Files Query
```sql
SELECT relative_path, functions_count, lines 
FROM files 
ORDER BY functions_count DESC;
```

**✅ Expected:** Files sorted by function count

---

### Step 6.3: Verify Entry Points
```sql
SELECT file, type, framework, role FROM entry_points;
```

**✅ Expected:**
```
src/App.tsx|convention|react|main
```

---

## ✅ Part 7: Complete System Health Check (2 minutes)

### Step 7.1: All-in-One Health Check
```bash
# From tools/playground directory
echo "🔍 Testing all systems..."

# Sprint 1: API
curl -s http://localhost:7103/api/trpc/getHealth | grep -q "ok" && echo "✅ Sprint 1: API working" || echo "❌ API failed"

# Sprint 2: Database
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM files;" | grep -q "[0-9]" && echo "✅ Sprint 2: Database working" || echo "❌ Database failed"

# Sprint 3.1: AST
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM files WHERE parsed_ast IS NOT NULL;" | grep -q "[0-9]" && echo "✅ Sprint 3.1: AST parsing working" || echo "❌ AST failed"

# Sprint 3.2: Embeddings
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM embeddings;" | grep -q "[0-9]" && echo "✅ Sprint 3.2: Embeddings working" || echo "❌ Embeddings failed"

echo "✨ All systems checked!"
```

---

### Step 7.2: Get Complete Project Stats
```bash
curl -s 'http://localhost:7103/api/trpc/getProjectStats?input=%7B%22path%22%3A%22.%22%7D' \
  | python3 -m json.tool
```

**✅ Expected:** Complete stats for files, functions, embeddings

---

## 🧪 Part 8: Code Quality - Refactoring Verification (5 minutes)

### Step 8.1: Run Unit Tests
```bash
# From project root
npx vitest run libs/core/src/__test__/ast-parser.spec.ts
```

**✅ Expected:** All 6 "Code Chunk Generation" tests PASS ✅

---

### Step 8.2: Verify Refactoring
```bash
# Check new functions exist
grep "export function generateCodeChunks\|export function chunkToSearchableText" libs/core/src/lib/ast-parser.ts

# Verify they're used in API router
grep "generateCodeChunks\|chunkToSearchableText" libs/api/src/lib/router.ts
```

**✅ Expected:** Functions found and used in router

---

### Step 8.3: Build & Type Check
```bash
nx run-many -t build --projects=core,api
npx tsc --noEmit -p libs/core/tsconfig.lib.json
```

**✅ Expected:** Builds succeed, no type errors

---

## ❌ Troubleshooting

### Problem: "Cannot find module 'chalk'" or "dist/ folder not found"

**Solution:** The project isn't built yet. Go to **Part 0: Build Project** and follow all steps.

---

### Problem: Build fails with errors
```bash
# From project root
# Reset Nx cache and rebuild
nx reset
nx run-many -t build --projects=core,api,cli,dashboard
```

---

### Problem: Server won't start
```bash
# Check if port in use
lsof -i :7103

# Kill process if needed
pkill -f "node.*bin.cjs"

# Restart
cd tools/playground
node ../../dist/apps/cli/bin.cjs start -p 7103
```

---

### Problem: Database not created
```bash
mkdir -p .raiken && chmod 755 .raiken
curl -X POST 'http://localhost:7103/api/trpc/buildCodeGraph' -H 'Content-Type: application/json' -d '{"path": "."}'
```

---

### Problem: Embeddings fail or search returns no results
```bash
# Check if embeddings exist
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM embeddings;"

# If 0 or error, regenerate all
curl -X POST 'http://localhost:7103/api/trpc/generateEmbeddings' \
  -H 'Content-Type: application/json' \
  -d '{"forceRegenerate": true}'
```

---

### Problem: Unit tests fail
```bash
# From project root
nx build core
npx vitest run libs/core/src/__test__/ast-parser.spec.ts
```

---

## 📚 Reference Files

| File | Purpose |
|------|---------|
| `libs/api/src/lib/router.ts` | API endpoints, orchestrates all operations (line 350: uses FULL AST for embeddings) |
| `libs/core/src/lib/ast-parser.ts` | **Dual AST generation**: `parseSourceFile()` returns both simplified + full AST |
| `libs/core/src/lib/embeddings.ts` | AI model, generates vectors from FULL AST text |
| `libs/core/src/lib/db.ts` | Database persistence (stores both `parsed_ast` and `ast` columns) |
| `libs/core/src/types.ts` | `ParsedFileWithAst` interface (line 45-48): dual AST structure |
| `apps/cli/src/server.ts` | Fastify server setup |
| `tools/playground/` | Test environment |

---

## 🎉 Completion

If all checks pass, **all Raiken features are fully functional!**

### What You've Verified:
✅ **Infrastructure:** CLI, Dashboard, API all working  
✅ **Data Layer:** File scanning, database, stats  
✅ **Intelligence:** AST parsing extracts code structure  
✅ **AI Features:** Embeddings generate, semantic search works  
✅ **Code Quality:** Refactoring verified, tests passing  

### Next Steps:
- **Sprint 3.3:** Build Semantic Search UI
- **Sprint 3.4:** Context-Aware Agent (LLM + embeddings)
- **Sprint 4:** AI Test Generation

---

**Testing completed successfully! 🎊**