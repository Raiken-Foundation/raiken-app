# Raiken System Testing Guide

**Version**: 1.0  
**Last Updated**: January 7, 2026  
**Purpose**: Comprehensive manual testing guide for Raiken features

---

## Table of Contents
1. [Prerequisites](#prerequisites)
2. [Test Environment Setup](#test-environment-setup)
3. [Test Suite 1: CLI Installation & Build](#test-suite-1-cli-installation--build)
4. [Test Suite 2: Project Initialization](#test-suite-2-project-initialization)
5. [Test Suite 3: Server Operations](#test-suite-3-server-operations)
6. [Test Suite 4: Code Analysis Engine](#test-suite-4-code-analysis-engine)
7. [Test Suite 5: Database Operations](#test-suite-5-database-operations)
8. [Test Suite 6: API Endpoints](#test-suite-6-api-endpoints)
9. [Test Suite 7: Dashboard UI](#test-suite-7-dashboard-ui)
10. [Test Suite 8: Integration Tests](#test-suite-8-integration-tests)
11. [Test Suite 9: Error Handling](#test-suite-9-error-handling)
12. [Performance Benchmarks](#performance-benchmarks)
13. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Required Software
- [ ] Node.js v18 or higher (`node --version`)
- [ ] npm/pnpm/yarn package manager
- [ ] SQLite CLI tools (optional, for database inspection)
- [ ] curl or similar HTTP client
- [ ] Python 3 (for JSON formatting in tests)
- [ ] Git

### Optional Tools
- [ ] Playwright Test (for UI testing)
- [ ] Browser Developer Tools
- [ ] Database viewer (DB Browser for SQLite, DBeaver, etc.)
- [ ] REST client (Postman, Insomnia, etc.)

### Knowledge Requirements
- [ ] Basic command line usage
- [ ] Understanding of REST APIs
- [ ] Basic SQL knowledge (for database tests)
- [ ] JavaScript/TypeScript basics

---

## Test Environment Setup

### Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/Raiken-Foundation/raiken-app.git
cd raiken-app

# Install dependencies
pnpm install
# or: npm install
```

**Expected Result**: ✅ All dependencies installed without errors

### Step 2: Build the Project

```bash
# Build all projects
nx run-many -t build
```

**Expected Result**: 
- ✅ Build completes successfully
- ✅ Output in `dist/apps/cli/` directory
- ✅ Dashboard assets in `dist/apps/cli/public/`

**Verify**:
```bash
ls -la dist/apps/cli/
# Should see: bin.cjs, index.cjs, public/, node_modules/
```

### Step 3: Install CLI Dependencies

```bash
cd dist/apps/cli
npm install
cd ../../..
```

**Expected Result**: ✅ Dependencies installed in dist directory

---

## Test Suite 1: CLI Installation & Build

### Test 1.1: CLI Binary Exists and is Executable

```bash
test -f dist/apps/cli/bin.cjs && echo "✅ PASS: Binary exists" || echo "❌ FAIL: Binary missing"
```

**Expected**: ✅ PASS: Binary exists

### Test 1.2: CLI Version Command

```bash
node dist/apps/cli/bin.cjs --version
```

**Expected**: Displays version number (e.g., `0.0.1`)

### Test 1.3: CLI Help Command

```bash
node dist/apps/cli/bin.cjs --help
```

**Expected Output**:
```
Usage: raiken [options] [command]

AI QA Agent for Developers

Options:
  -V, --version   output the version number
  -h, --help      display help for command

Commands:
  start [options] Start the Raiken Dashboard & Agent
  init [options]  Initialize Raiken in the current project
  help [command]  display help for command
```

### Test 1.4: Verify Dashboard Assets

```bash
ls -lh dist/apps/cli/public/assets/
```

**Expected**: 
- ✅ At least 2 files (CSS and JS)
- ✅ Files have reasonable sizes (>50KB for JS)

---

## Test Suite 2: Project Initialization

### Test 2.1: Initialize in Playground (Clean State)

**Setup**:
```bash
# Clean any existing Raiken files
cd tools/playground
rm -rf .raiken/
rm -f raiken.config.json
cd ../..
```

**Test**:
```bash
cd tools/playground
node ../../dist/apps/cli/bin.cjs init
```

**Interactive Prompts** - Verify you see:
1. ✅ "Analyzing your project..." message
2. ✅ Detected project information displayed
3. ✅ Interactive prompts for confirmation

**Manual Steps**:
- Select default options or customize as needed
- Complete the initialization

**Expected Results**:
- ✅ `.raiken/` directory created
- ✅ `.raiken/README.md` present
- ✅ `.raiken/cache/` subdirectory exists
- ✅ `.gitignore` contains `.raiken/`
- ✅ `package.json` updated with scripts
- ✅ Success message displayed

**Verification Commands**:
```bash
# Check directory structure
ls -la .raiken/
# Should see: README.md, cache/

# Check .gitignore
grep ".raiken" .gitignore
# Should see: .raiken/

# Check package.json
grep "raiken" package.json
# Should see: "raiken": "raiken start"
```

### Test 2.2: Re-initialize (Existing Config)

```bash
node ../../dist/apps/cli/bin.cjs init
```

**Expected**:
- ✅ Detects existing configuration
- ✅ Prompts before overwriting (or skips with message)
- ✅ Graceful handling of existing files

### Test 2.3: Initialize with Force Flag

```bash
node ../../dist/apps/cli/bin.cjs init --force
```

**Expected**:
- ✅ Overwrites existing configuration
- ✅ No prompts for existing files
- ✅ Completes successfully

### Test 2.4: Project Detection Accuracy

**Test Command**:
```bash
node ../../dist/apps/cli/bin.cjs start &
sleep 2
curl http://localhost:7101/api/project-info | python3 -m json.tool
```

**Expected Output**:
```json
{
    "name": "@raiken/playground",
    "cwd": "/path/to/playground",
    "projectType": "react",
    "packageManager": "npm",
    "testDir": "tests",
    "testFramework": "playwright"
}
```

**Verify**:
- ✅ `projectType`: Should be "react" (not generic)
- ✅ `packageManager`: Should match your lock file (npm, pnpm, etc.)
- ✅ `testFramework`: Should be "playwright" (not "none")
- ✅ `testDir`: Should be "tests"

---

## Test Suite 3: Server Operations

### Test 3.1: Server Startup

```bash
cd tools/playground
node ../../dist/apps/cli/bin.cjs start
```

**Expected Console Output**:
```
Initializing Raiken...
{"level":30,"time":...,"msg":"Server listening at http://127.0.0.1:7101"}
🚀 Raiken UI running at http://localhost:7101
```

**Verify**:
- ✅ Server starts without errors
- ✅ Port 7101 is used
- ✅ Clear success message
- ✅ No crash or exit

### Test 3.2: Server Health Check

**In a new terminal**:
```bash
curl http://localhost:7101/api/trpc/getHealth | python3 -m json.tool
```

**Expected**:
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

### Test 3.3: Port Conflict Handling

```bash
# In terminal 1: Start server
node ../../dist/apps/cli/bin.cjs start

# In terminal 2: Try to start another instance
node ../../dist/apps/cli/bin.cjs start
```

**Expected**:
- ✅ Second instance fails gracefully
- ✅ Error message about port in use
- ✅ First instance continues running

### Test 3.4: Graceful Shutdown

```bash
# Start server
node ../../dist/apps/cli/bin.cjs start

# Send SIGINT (Ctrl+C)
# Or: kill -SIGINT <pid>
```

**Expected**:
- ✅ Server shuts down cleanly
- ✅ No error messages
- ✅ Database connections closed

---

## Test Suite 4: Code Analysis Engine

### Test 4.1: Entry Point Detection

**API Call**:
```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Afalse%7D%7D" | python3 -c "import sys, json; data=json.load(sys.stdin); print(json.dumps(data['result']['data']['entryPoints'], indent=2))"
```

**Expected Output**:
```json
[
  {
    "file": "src/App.tsx",
    "framework": "react",
    "role": "main",
    "type": "convention"
  }
]
```

**Verify**:
- ✅ At least 1 entry point found
- ✅ Framework detected correctly ("react")
- ✅ File path is relative

### Test 4.2: File Discovery

**API Call**:
```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Afalse%7D%7D" | python3 -c "import sys, json; data=json.load(sys.stdin); print('Total files:', data['result']['data']['stats']['totalFiles'])"
```

**Expected**: `Total files: 6`

**Verify All Files Found**:
```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Afalse%7D%7D" | python3 -c "import sys, json; data=json.load(sys.stdin); files = [f['path'] for f in data['result']['data']['files']]; print('\n'.join(sorted(files)))"
```

**Expected Files**:
- ✅ src/App.tsx
- ✅ src/components/Counter.tsx
- ✅ src/components/LoginForm.tsx
- ✅ src/components/TodoList.tsx
- ✅ src/utils.ts
- ✅ src/types.ts

### Test 4.3: AST Parsing Accuracy

**Check Function Counts**:
```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Afalse%7D%7D" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for file in data['result']['data']['files']:
    print(f\"{file['path']}: {file['functions']} functions, {file['types']} types\")
"
```

**Expected Output**:
```
src/App.tsx: 3 functions, 0 types
src/components/Counter.tsx: 4 functions, 0 types
src/components/LoginForm.tsx: 2 functions, 1 types
src/components/TodoList.tsx: 5 functions, 0 types
src/utils.ts: 9 functions, 0 types
src/types.ts: 0 functions, 3 types
```

**Verify**:
- ✅ Function counts are accurate
- ✅ Type counts are accurate
- ✅ Total functions: 23
- ✅ Total types: 4

### Test 4.4: Dependency Mapping

**Check Imports for App.tsx**:
```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Afalse%7D%7D" | python3 -c "
import sys, json
data = json.load(sys.stdin)
app_file = [f for f in data['result']['data']['files'] if 'App.tsx' in f['path']][0]
print('Imports:')
for imp in app_file['imports']:
    print(f'  - {imp}')
"
```

**Expected**:
- ✅ src/components/Counter.tsx
- ✅ src/components/TodoList.tsx
- ✅ src/components/LoginForm.tsx

### Test 4.5: Bidirectional Dependencies

**Check what imports utils.ts**:
```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Afalse%7D%7D" | python3 -c "
import sys, json
data = json.load(sys.stdin)
utils = [f for f in data['result']['data']['files'] if 'utils.ts' in f['path']][0]
print('utils.ts is imported by:')
for imp in utils['importedBy']:
    print(f'  - {imp}')
"
```

**Expected** (utils.ts is used by multiple files):
- ✅ src/components/Counter.tsx
- ✅ src/components/TodoList.tsx
- ✅ src/components/LoginForm.tsx (if it imports utils)

### Test 4.6: Depth Calculation

```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Afalse%7D%7D" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for file in sorted(data['result']['data']['files'], key=lambda x: x['depth']):
    print(f\"Depth {file['depth']}: {file['path']}\")
"
```

**Expected**:
```
Depth 0: src/App.tsx
Depth 1: src/components/Counter.tsx
Depth 1: src/components/LoginForm.tsx
Depth 1: src/components/TodoList.tsx
Depth 2: src/utils.ts
Depth 3: src/types.ts
```

### Test 4.7: Performance Test

```bash
time curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null
```

**Expected**:
- ✅ Completes in < 5 seconds
- ✅ No errors or timeouts

---

## Test Suite 5: Database Operations

### Test 5.1: Database File Creation

```bash
# Trigger a scan with persist=true
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null

# Check database exists
ls -lh .raiken/raiken.db
```

**Expected**:
- ✅ Database file exists
- ✅ File size > 50KB
- ✅ File has read/write permissions

### Test 5.2: Schema Verification

```bash
sqlite3 .raiken/raiken.db ".tables"
```

**Expected Output**:
```
dependencies  entry_points  files         stats
```

**Verify**:
- ✅ All 4 tables present
- ✅ No unexpected tables

### Test 5.3: Files Table Data

```bash
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM files;"
```

**Expected**: `6`

**Detailed Check**:
```bash
sqlite3 .raiken/raiken.db "SELECT relative_path, functions_count, lines FROM files ORDER BY depth;"
```

**Expected**:
```
src/App.tsx|3|56
src/components/Counter.tsx|4|59
src/components/TodoList.tsx|5|134
src/components/LoginForm.tsx|2|82
src/utils.ts|9|58
src/types.ts|0|15
```

### Test 5.4: Dependencies Table

```bash
sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM dependencies;"
```

**Expected**: 8 (or similar, based on actual imports)

**Sample Dependencies**:
```bash
sqlite3 .raiken/raiken.db "SELECT source_file, target_file FROM dependencies LIMIT 5;" | sed 's|/Users/.*/playground/||g'
```

**Expected Pattern**: Paths showing import relationships

### Test 5.5: Entry Points Table

```bash
sqlite3 .raiken/raiken.db "SELECT file_path, framework, role FROM entry_points;"
```

**Expected**: 
- ✅ Contains entry point (src/App.tsx or similar)
- ✅ Framework: "react"
- ✅ Role: "main"

### Test 5.6: Stats Table

```bash
sqlite3 .raiken/raiken.db "SELECT total_files, total_functions, total_types FROM stats;"
```

**Expected**: `6|23|4`

### Test 5.7: Content Hash Stability

```bash
# Run scan twice
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null
HASH1=$(sqlite3 .raiken/raiken.db "SELECT content_hash FROM files WHERE relative_path='src/utils.ts';")

curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null
HASH2=$(sqlite3 .raiken/raiken.db "SELECT content_hash FROM files WHERE relative_path='src/utils.ts';")

[ "$HASH1" = "$HASH2" ] && echo "✅ PASS: Hashes are stable" || echo "❌ FAIL: Hashes differ"
```

### Test 5.8: Incremental Update (Advanced)

```bash
# Initial scan
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null

# Get initial timestamp
TIME1=$(sqlite3 .raiken/raiken.db "SELECT last_indexed FROM files WHERE relative_path='src/utils.ts';")

# Wait a moment
sleep 2

# Modify a file
echo "// Test comment" >> src/utils.ts

# Rescan
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null

# Get new timestamp
TIME2=$(sqlite3 .raiken/raiken.db "SELECT last_indexed FROM files WHERE relative_path='src/utils.ts';")

# Cleanup
git checkout src/utils.ts

# Verify
[ "$TIME1" != "$TIME2" ] && echo "✅ PASS: File was re-indexed" || echo "❌ FAIL: Timestamp unchanged"
```

### Test 5.9: View AST Tree for a File

The complete AST (Abstract Syntax Tree) is stored in the database for each file. You can retrieve it:

**View AST as JSON**:
```bash
sqlite3 .raiken/raiken.db "SELECT parsed_ast FROM files WHERE relative_path='src/utils.ts';" | python3 -m json.tool
```

**Expected Output** (sample structure):
```json
{
  "functions": [
    {
      "name": "sum",
      "params": ["a", "b"],
      "isAsync": false,
      "isExported": true,
      "line": 5
    },
    {
      "name": "formatDate",
      "params": ["date"],
      "isAsync": false,
      "isExported": true,
      "line": 12
    }
  ],
  "classes": [],
  "imports": [
    {
      "source": "./types",
      "specifiers": [
        {
          "type": "named",
          "imported": "User",
          "local": "User"
        }
      ],
      "isTypeOnly": true,
      "line": 1
    }
  ],
  "exports": [
    {
      "type": "named",
      "name": "sum",
      "line": 5
    }
  ],
  "types": []
}
```

**View AST for All Files**:
```bash
sqlite3 .raiken/raiken.db "SELECT relative_path, parsed_ast FROM files;" | while IFS='|' read -r path ast; do
  echo "=== $path ==="
  echo "$ast" | python3 -m json.tool | head -30
  echo ""
done
```

**Extract Specific Information from AST**:

```bash
# Get all function names from a file
sqlite3 .raiken/raiken.db "SELECT parsed_ast FROM files WHERE relative_path='src/utils.ts';" | python3 -c "
import sys, json
ast = json.load(sys.stdin)
print('Functions:')
for func in ast['functions']:
    exported = '(exported)' if func['isExported'] else ''
    async_flag = 'async ' if func['isAsync'] else ''
    params = ', '.join(func['params'])
    print(f\"  Line {func['line']}: {async_flag}{func['name']}({params}) {exported}\")
"
```

**Expected Output**:
```
Functions:
  Line 5: sum(a, b) (exported)
  Line 9: multiply(a, b) (exported)
  Line 13: divide(a, b) (exported)
  Line 18: formatDate(date) (exported)
  Line 24: validateEmail(email) (exported)
  Line 30: generateId() (exported)
  Line 34: debounce(func, wait) (exported)
  Line 43: throttle(func, limit) (exported)
  Line 52: deepClone(obj) (exported)
```

**Get All Imports**:
```bash
sqlite3 .raiken/raiken.db "SELECT parsed_ast FROM files WHERE relative_path='src/App.tsx';" | python3 -c "
import sys, json
ast = json.load(sys.stdin)
print('Imports:')
for imp in ast['imports']:
    specifiers = ', '.join([s['local'] for s in imp['specifiers']])
    type_only = ' (type-only)' if imp.get('isTypeOnly') else ''
    print(f\"  Line {imp['line']}: {specifiers} from '{imp['source']}'{type_only}\")
"
```

**Get All Exports**:
```bash
sqlite3 .raiken/raiken.db "SELECT parsed_ast FROM files WHERE relative_path='src/components/Counter.tsx';" | python3 -c "
import sys, json
ast = json.load(sys.stdin)
print('Exports:')
for exp in ast['exports']:
    if exp['type'] == 'default':
        print(f\"  Line {exp['line']}: export default {exp.get('name', '(anonymous)')}\")
    else:
        print(f\"  Line {exp['line']}: export {exp['name']}\")
"
```

**Verify**:
- ✅ AST contains complete parsed structure
- ✅ All functions, classes, types extracted
- ✅ Import/export information preserved
- ✅ Line numbers tracked for source mapping

---

## Test Suite 6: API Endpoints

### Test 6.1: getHealth

```bash
curl -s "http://localhost:7101/api/trpc/getHealth" | python3 -m json.tool
```

**Expected**:
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

### Test 6.2: getProjectInfo

```bash
curl -s "http://localhost:7101/api/trpc/getProjectInfo" | python3 -m json.tool
```

**Expected**:
```json
{
    "result": {
        "data": {
            "path": "/path/to/playground",
            "nodeVersion": "v18.x.x"
        }
    }
}
```

### Test 6.3: getGraphStats

```bash
curl -s "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D" | python3 -m json.tool
```

**Expected**:
```json
{
    "result": {
        "data": {
            "projectPath": "/path/to/playground",
            "totalFiles": 6,
            "totalSize": 10218,
            "totalSizeFormatted": "9.98 KB",
            "totalLines": 404,
            "totalFunctions": 23,
            "totalClasses": 0,
            "totalTypes": 4,
            "lastScan": "2026-01-07T..."
        }
    }
}
```

### Test 6.4: getGraphFiles (Pagination)

```bash
# First page
curl -s "http://localhost:7101/api/trpc/getGraphFiles?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22limit%22%3A3%2C%22offset%22%3A0%7D%7D" | python3 -c "
import sys, json
data = json.load(sys.stdin)['result']['data']
print(f\"Total: {data['total']}, Returned: {len(data['files'])}, HasMore: {data['hasMore']}\")
"
```

**Expected**: `Total: 6, Returned: 3, HasMore: True`

```bash
# Second page
curl -s "http://localhost:7101/api/trpc/getGraphFiles?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22limit%22%3A3%2C%22offset%22%3A3%7D%7D" | python3 -c "
import sys, json
data = json.load(sys.stdin)['result']['data']
print(f\"Total: {data['total']}, Returned: {len(data['files'])}, HasMore: {data['hasMore']}\")
"
```

**Expected**: `Total: 6, Returned: 3, HasMore: False`

### Test 6.5: getDatabaseTables

```bash
curl -s "http://localhost:7101/api/trpc/getDatabaseTables?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D" | python3 -m json.tool
```

**Expected**:
```json
{
    "result": {
        "data": {
            "tables": [
                {"name": "dependencies", "rowCount": 8},
                {"name": "entry_points", "rowCount": 1},
                {"name": "files", "rowCount": 6},
                {"name": "stats", "rowCount": 1}
            ],
            "timestamp": "2026-01-07T..."
        }
    }
}
```

### Test 6.6: Error Handling (Invalid Path)

```bash
curl -s "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22%2Fnonexistent%2Fpath%22%7D%7D" | python3 -m json.tool
```

**Expected**:
- ✅ Returns error object (not crash)
- ✅ Error message is descriptive
- ✅ HTTP status appropriate

---

## Test Suite 7: Dashboard UI

### Test 7.1: Dashboard Loads

**Manual Test**:
1. Open browser to `http://localhost:7101`
2. Wait for page to load

**Expected**:
- ✅ Page loads without errors
- ✅ No console errors in DevTools
- ✅ React app renders
- ✅ UI is visible and styled

### Test 7.2: Navigation

**Manual Test**:
1. Check if multiple views exist (Landing, Overview, Testing)
2. Navigate between views if available

**Expected**:
- ✅ Navigation works
- ✅ URLs update (if using routing)
- ✅ Views render correctly

### Test 7.3: Code Graph Visualization

**Manual Test**:
1. Find "Scan Project" or similar button
2. Click to trigger code graph building
3. Observe results

**Expected**:
- ✅ Loading indicator appears
- ✅ Results display after completion
- ✅ File list shown
- ✅ Statistics displayed

### Test 7.4: Database Viewer

**Manual Test**:
1. Find database viewer icon/button
2. Click to open database viewer
3. Browse tables

**Expected**:
- ✅ Database viewer opens
- ✅ Tables listed
- ✅ Can click on table to view data
- ✅ Data displays correctly

### Test 7.5: React Query DevTools

**Manual Test**:
1. Look for React Query DevTools icon (bottom-left)
2. Click to open
3. Inspect queries

**Expected**:
- ✅ DevTools opens
- ✅ Shows active queries
- ✅ Query states visible (loading, success, error)
- ✅ Can inspect query data

### Test 7.6: Network Requests

**Manual Test**:
1. Open browser DevTools → Network tab
2. Trigger a code graph scan
3. Observe network requests

**Expected**:
- ✅ Request to `/api/trpc/buildCodeGraph`
- ✅ Status 200
- ✅ Response contains data
- ✅ Request batching (if multiple queries)

### Test 7.7: Responsive Design

**Manual Test**:
1. Resize browser window
2. Test at different widths (mobile, tablet, desktop)

**Expected**:
- ✅ Layout adapts to different sizes
- ✅ No horizontal scrolling
- ✅ Elements remain usable

### Test 7.8: Error Display

**Manual Test**:
1. Stop the backend server
2. Try to trigger an API call from UI
3. Observe error handling

**Expected**:
- ✅ Error message displayed
- ✅ UI doesn't crash
- ✅ User-friendly error text

---

## Test Suite 8: Integration Tests

### Test 8.1: End-to-End: Init → Scan → Query

```bash
# Step 1: Initialize (skip if already done)
cd tools/playground
node ../../dist/apps/cli/bin.cjs init

# Step 2: Start server
node ../../dist/apps/cli/bin.cjs start &
SERVER_PID=$!
sleep 3

# Step 3: Trigger scan
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null

# Step 4: Query stats
STATS=$(curl -s "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D")

# Step 5: Verify database
DB_COUNT=$(sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM files;")

# Step 6: Cleanup
kill $SERVER_PID

# Verify
echo "$STATS" | grep -q "totalFiles" && echo "✅ PASS: Stats retrieved" || echo "❌ FAIL"
[ "$DB_COUNT" -eq 6 ] && echo "✅ PASS: Database populated" || echo "❌ FAIL: Expected 6 files, got $DB_COUNT"
```

### Test 8.2: Multiple Projects

**Test that Raiken can handle different projects**:

```bash
# Test in raiken-app root (larger project)
cd /path/to/raiken-app
node dist/apps/cli/bin.cjs start &
sleep 3

# Trigger scan
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > scan.json

# Check results
cat scan.json | python3 -c "import sys, json; data=json.load(sys.stdin); print(f\"Found {data['result']['data']['stats']['totalFiles']} files\")"

# Cleanup
kill %1
rm scan.json
```

**Expected**:
- ✅ Scans successfully
- ✅ Finds many more files (100+)
- ✅ Completes in reasonable time (<30s)

### Test 8.3: Concurrent Requests

```bash
# Start server
cd tools/playground
node ../../dist/apps/cli/bin.cjs start &
sleep 3

# Send multiple requests simultaneously
for i in {1..5}; do
  curl -s "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D" > /dev/null &
done

wait

echo "✅ All requests completed"
kill %1
```

**Expected**:
- ✅ All requests complete successfully
- ✅ No crashes or errors
- ✅ Server remains stable

---

## Test Suite 9: Error Handling

### Test 9.1: Invalid Project Path

```bash
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22%2Finvalid%2Fpath%22%7D%7D" | python3 -m json.tool
```

**Expected**:
- ✅ Returns error (not crash)
- ✅ Error message describes issue
- ✅ Server continues running

### Test 9.2: Malformed API Request

```bash
curl -s -X POST "http://localhost:7101/api/trpc/buildCodeGraph" \
  -H "Content-Type: application/json" \
  -d '{invalid json}' | python3 -m json.tool
```

**Expected**:
- ✅ Returns 400 Bad Request or similar
- ✅ Error message indicates JSON parsing issue

### Test 9.3: Missing Database

```bash
# Remove database
rm .raiken/raiken.db

# Try to query stats
curl -s "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D" | python3 -m json.tool
```

**Expected**:
- ✅ Returns null or empty result (not error)
- ✅ Or error message indicating no scan performed yet

### Test 9.4: File Permission Issues

```bash
# Make .raiken directory read-only
chmod 444 .raiken

# Try to scan (will fail to write database)
curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" | python3 -m json.tool

# Cleanup
chmod 755 .raiken
```

**Expected**:
- ✅ Error returned
- ✅ Error mentions permission issue
- ✅ Server doesn't crash

---

## Performance Benchmarks

### Benchmark 1: Small Project (6 files)

```bash
time curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null
```

**Target**: < 5 seconds  
**Record your result**: _________ seconds

### Benchmark 2: Database Query Performance

```bash
time curl -s "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D" > /dev/null
```

**Target**: < 100ms  
**Record your result**: _________ ms

### Benchmark 3: Multiple Queries (Batch)

```bash
time for i in {1..10}; do
  curl -s "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D" > /dev/null
done
```

**Target**: < 1 second total  
**Record your result**: _________ seconds

### Benchmark 4: Large Project (Raiken Itself)

```bash
cd /path/to/raiken-app
time curl -s "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null
```

**Target**: < 30 seconds  
**Record your result**: _________ seconds  
**Files found**: _________

---

## Troubleshooting

### Issue: Server won't start

**Symptoms**: Error when running `raiken start`

**Solutions**:
1. Check if port 7101 is already in use:
   ```bash
   lsof -i :7101
   # If something is using it: kill <PID>
   ```

2. Check Node.js version:
   ```bash
   node --version  # Should be v18+
   ```

3. Check dependencies installed:
   ```bash
   cd dist/apps/cli
   ls node_modules/  # Should have many packages
   ```

### Issue: Module not found errors

**Symptoms**: Error: Cannot find module 'chalk' or similar

**Solution**:
```bash
cd dist/apps/cli
rm -rf node_modules
npm install
cd ../../..
```

### Issue: Database errors

**Symptoms**: SQLITE_BUSY or similar errors

**Solutions**:
1. Close any SQLite viewers
2. Delete database and rescan:
   ```bash
   rm .raiken/raiken.db
   # Trigger new scan
   ```

### Issue: API returns errors

**Symptoms**: tRPC errors, 404s, etc.

**Solutions**:
1. Check server is running:
   ```bash
   curl http://localhost:7101/api/trpc/getHealth
   ```

2. Check logs in terminal running server

3. Verify project path in request

### Issue: Dashboard shows blank screen

**Symptoms**: White screen, no UI

**Solutions**:
1. Check browser console for errors (F12)
2. Verify assets loaded (Network tab)
3. Try hard refresh (Ctrl+Shift+R)
4. Verify server serving static files:
   ```bash
   curl -I http://localhost:7101/
   ```

### Issue: Slow performance

**Symptoms**: Scans taking very long

**Solutions**:
1. Check project size:
   ```bash
   find src -name "*.ts" -o -name "*.tsx" | wc -l
   ```

2. Check for large node_modules being scanned (should be ignored)

3. Verify .gitignore is respected

---

## Test Results Template

Copy this template to record your test results:

```markdown
## Test Results

**Date**: _________  
**Tester**: _________  
**Environment**: _________  
**Node Version**: _________  
**OS**: _________  

### Suite 1: CLI Installation & Build
- [ ] Test 1.1: Binary exists
- [ ] Test 1.2: Version command
- [ ] Test 1.3: Help command
- [ ] Test 1.4: Dashboard assets

### Suite 2: Project Initialization
- [ ] Test 2.1: Clean initialization
- [ ] Test 2.2: Re-initialization
- [ ] Test 2.3: Force flag
- [ ] Test 2.4: Detection accuracy

### Suite 3: Server Operations
- [ ] Test 3.1: Server startup
- [ ] Test 3.2: Health check
- [ ] Test 3.3: Port conflicts
- [ ] Test 3.4: Graceful shutdown

### Suite 4: Code Analysis
- [ ] Test 4.1: Entry point detection
- [ ] Test 4.2: File discovery
- [ ] Test 4.3: AST parsing
- [ ] Test 4.4: Dependency mapping
- [ ] Test 4.5: Bidirectional deps
- [ ] Test 4.6: Depth calculation
- [ ] Test 4.7: Performance

### Suite 5: Database Operations
- [ ] Test 5.1: DB creation
- [ ] Test 5.2: Schema verification
- [ ] Test 5.3: Files table
- [ ] Test 5.4: Dependencies table
- [ ] Test 5.5: Entry points table
- [ ] Test 5.6: Stats table
- [ ] Test 5.7: Hash stability
- [ ] Test 5.8: Incremental updates
- [ ] Test 5.9: View AST tree

### Suite 6: API Endpoints
- [ ] Test 6.1: getHealth
- [ ] Test 6.2: getProjectInfo
- [ ] Test 6.3: getGraphStats
- [ ] Test 6.4: getGraphFiles
- [ ] Test 6.5: getDatabaseTables
- [ ] Test 6.6: Error handling

### Suite 7: Dashboard UI
- [ ] Test 7.1: Dashboard loads
- [ ] Test 7.2: Navigation
- [ ] Test 7.3: Code graph viz
- [ ] Test 7.4: Database viewer
- [ ] Test 7.5: DevTools
- [ ] Test 7.6: Network requests
- [ ] Test 7.7: Responsive design
- [ ] Test 7.8: Error display

### Suite 8: Integration
- [ ] Test 8.1: End-to-end flow
- [ ] Test 8.2: Multiple projects
- [ ] Test 8.3: Concurrent requests

### Suite 9: Error Handling
- [ ] Test 9.1: Invalid path
- [ ] Test 9.2: Malformed request
- [ ] Test 9.3: Missing database
- [ ] Test 9.4: Permissions

### Performance Benchmarks
- Small project scan: _______ seconds
- Stats query: _______ ms
- 10 queries: _______ seconds
- Large project: _______ seconds (_____ files)

### Issues Found
1. ___________
2. ___________
3. ___________

### Notes
___________
```

---

## Quick Test Script

Save this as `quick-test.sh` for rapid testing:

```bash
#!/bin/bash
set -e

echo "🧪 Raiken Quick Test Suite"
echo "=========================="

cd tools/playground

echo ""
echo "1️⃣ Starting server..."
node ../../dist/apps/cli/bin.cjs start &
SERVER_PID=$!
sleep 3

echo ""
echo "2️⃣ Testing health endpoint..."
curl -sf http://localhost:7101/api/trpc/getHealth > /dev/null && echo "✅ Health check passed" || echo "❌ Health check failed"

echo ""
echo "3️⃣ Building code graph..."
curl -sf "http://localhost:7101/api/trpc/buildCodeGraph?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%2C%22persist%22%3Atrue%7D%7D" > /dev/null && echo "✅ Code graph built" || echo "❌ Code graph failed"

echo ""
echo "4️⃣ Verifying database..."
[ -f .raiken/raiken.db ] && echo "✅ Database exists" || echo "❌ Database missing"
FILE_COUNT=$(sqlite3 .raiken/raiken.db "SELECT COUNT(*) FROM files;" 2>/dev/null || echo "0")
[ "$FILE_COUNT" -eq 6 ] && echo "✅ Correct file count ($FILE_COUNT)" || echo "❌ Wrong file count (expected 6, got $FILE_COUNT)"

echo ""
echo "5️⃣ Testing stats endpoint..."
curl -sf "http://localhost:7101/api/trpc/getGraphStats?input=%7B%22json%22%3A%7B%22path%22%3A%22$(pwd)%22%7D%7D" | grep -q "totalFiles" && echo "✅ Stats endpoint works" || echo "❌ Stats endpoint failed"

echo ""
echo "6️⃣ Cleaning up..."
kill $SERVER_PID 2>/dev/null
echo "✅ Server stopped"

echo ""
echo "=========================="
echo "✅ Quick test completed!"
```

Make it executable:
```bash
chmod +x quick-test.sh
./quick-test.sh
```

---

## Automated Testing Script (Advanced)

For comprehensive automated testing, create `comprehensive-test.sh`:

```bash
#!/bin/bash

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASSED=0
FAILED=0

test_case() {
  local name=$1
  local command=$2
  local expected=$3
  
  echo -n "Testing: $name... "
  result=$(eval "$command" 2>&1)
  
  if [[ $result == *"$expected"* ]]; then
    echo -e "${GREEN}PASS${NC}"
    ((PASSED++))
  else
    echo -e "${RED}FAIL${NC}"
    echo "  Expected: $expected"
    echo "  Got: $result"
    ((FAILED++))
  fi
}

echo "🧪 Raiken Comprehensive Test Suite"
echo "===================================="

# Your tests here using test_case function

echo ""
echo "===================================="
echo -e "Results: ${GREEN}$PASSED passed${NC}, ${RED}$FAILED failed${NC}"
[ $FAILED -eq 0 ] && echo -e "${GREEN}All tests passed!${NC}" || echo -e "${RED}Some tests failed${NC}"
```

---

## Conclusion

This testing guide provides comprehensive coverage of all Raiken features. Regular testing ensures:
- ✅ Core functionality remains stable
- ✅ New features don't break existing ones
- ✅ Performance benchmarks are maintained
- ✅ User experience is consistent

**Recommended Testing Frequency**:
- **Before each release**: Full test suite
- **Daily development**: Quick test script
- **After major changes**: Relevant test suites
- **Performance tests**: Weekly

For bug reports or test failures, include:
1. Which test failed
2. Expected vs actual results
3. Environment details (OS, Node version)
4. Complete error messages
5. Steps to reproduce

