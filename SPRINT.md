### 🟢 Sprint 1: The "Walking Skeleton" (Infrastructure)

**Goal:** The CLI starts, serves the React UI, and the UI can talk to the CLI.

#### Step 1.1: Configure the Dev Proxy (Critical for DX)

In development, React runs on port `4200` (Vite) and Fastify on `7101`. We need to proxy API requests so you don't get CORS errors.

- **Action:** Update `apps/dashboard/vite.config.ts`:
  ```typescript
  server: {
    proxy: {
      '/api': 'http://localhost:7101', // Forward API calls to Fastify
      '/ws': { target: 'ws://localhost:7101', ws: true } // Forward WebSockets
    }
  }
  ```

#### Step 1.2: Build the API Bridge

- **Action:** In `apps/cli/src/server.ts`, add a simple route:
  ```typescript
  app.get('/api/project-info', async () => {
    return { path: process.cwd(), files: 0 };
  });
  ```

#### Step 1.3: Verification (How to Test)

1.  **Terminal 1 (Backend):** `nx serve cli` (Runs Fastify on 7101).
2.  **Terminal 2 (Frontend):** `nx serve dashboard` (Runs Vite on 4200).
3.  **Test:** Open `localhost:4200` (Not 7101 yet). Fetch `/api/project-info`. If you see JSON, the bridge is built.

---

### 🟡 Sprint 2: The "Sensors" (File Scanning & DB)

**Goal:** `libs/core` scans the `tools/playground` folder and stores it in SQLite.

#### Step 2.1: The Database Module (`libs/core`)

- **Action:** Create `libs/core/src/db.ts`.
  - Initialize `better-sqlite3`.
  - Create the `files` table schema (Path, Checksum, LastIndexed).

#### Step 2.2: The Scanner Logic

- **Action:** Create `libs/core/src/scanner.ts`.
  - Use `fast-glob` to find `**/*.{ts,tsx}`.
  - Loop through them and `INSERT` into the DB.

#### Step 2.3: Connect CLI to Core

- **Action:** In `apps/cli/src/bin.ts`, import the scanner.
  - When running `raiken start`, trigger the scan on `process.cwd()`.

#### Step 2.4: Verification

1.  **Run:** `cd tools/playground && node ../../dist/apps/cli/bin.js start`
2.  **Check:** Use a SQLite viewer to open `.raiken/raiken.db` inside the playground.
3.  **Success:** You should see `src/utils.ts` and `src/Login.tsx` in the rows.

---

### 🟠 Sprint 3: The "Brain" (AST & Embeddings)

**Goal:** Turn those files into searchable vectors.

#### Step 3.1: AST Parsing

- **Action:** Create `libs/core/src/parser.ts`.
  - Use `@babel/parser`. Extract `function` names and `export` definitions.

#### Step 3.2: Local Embeddings

- **Action:** Create `libs/core/src/embeddings.ts`.
  - Implement `Transformers.js`.
  - **Note:** This is heavy. Test this in isolation first using a Vitest unit test in `libs/core`.

#### Step 3.3: The Search API

- **Action:** Add an endpoint to `apps/cli/src/server.ts`:
  - `GET /api/search?q=Login`
  - This calls the Core lib -\> Vector Search -\> Returns file paths.

#### Step 3.4: Verification

1.  **Run:** The CLI in the playground.
2.  **Browser:** Go to the Dashboard. Create a simple input box.
3.  **Type:** "Login".
4.  **Success:** The UI displays `src/Login.tsx` as a result.

---

### 🔴 Sprint 4: The "Mouth" (AI Generation)

**Goal:** Generate a test file using OpenRouter.

#### Step 4.1: The Provider Setup

- **Action:** In `libs/core`, set up the Vercel AI SDK (`npm install ai @ai-sdk/openai`).
  - _Note:_ Even though it says openai, it works with OpenRouter by changing the `baseUrl`.

#### Step 4.2: The Generator Agent

- **Action:** Create `libs/core/src/agent.ts`.
  - Function: `generateTest(filesContext: File[], userPrompt: string)`.
  - Prompt Engineering: "You are a Playwright Expert..."

#### Step 4.3: The UI Streaming

- **Action:** In `apps/dashboard`, use the `useChat` hook from the AI SDK.
- **Action:** In `apps/cli`, connect the AI stream to the Fastify response.

#### Step 4.4: Verification

1.  **Run:** CLI in playground.
2.  **UI:** Type "Write a test for sum function".
3.  **Success:** You see code streaming onto the screen.

---

### 🟣 Sprint 5: The "Hands" (Running Tests)

**Goal:** Execute Playwright and stream logs.

#### Step 5.1: The Runner

- **Action:** `libs/core/src/runner.ts`.
  - Use `child_process.spawn('npx', ['playwright', 'test', ...])`.

#### Step 5.2: Real-time Logs (WebSockets)

- **Action:** Install `@fastify/websocket`.
  - When the test runs, pipe `stdout` -\> WebSocket -\> React Terminal Component.

---

### 📊 Summary: How to Test Effectively

You need **Three Loops** running during development.

| Loop Type                   | Command                                                            | Where it runs      | Purpose                                                       |
| :-------------------------- | :----------------------------------------------------------------- | :----------------- | :------------------------------------------------------------ |
| **1. The Logic Loop**       | `nx test core --watch`                                             | `libs/core`        | Unit testing DB/AST logic. Fast feedback.                     |
| **2. The UI Loop**          | `nx serve dashboard`                                               | `apps/dashboard`   | Pixel tweaking the React UI. Uses the proxy.                  |
| **3. The Integration Loop** | `nx run-many -t build --watch` <br> + <br> `nodemon` in playground | `tools/playground` | **The Real Test.** Simulates a user running the final binary. |

### Suggested Immediate Next Step

Start **Sprint 1**.
Get `nx serve cli` and `nx serve dashboard` running side-by-side and make the dashboard display: _"Connected to Raiken Backend"_.

Once that happens, the dopamine hit will keep the team moving.
