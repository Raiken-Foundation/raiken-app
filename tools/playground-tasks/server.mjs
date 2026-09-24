/**
 * NextAuth middleware simulator.
 *
 * Every route except the public auth paths returns a bare 302 → /auth/login,
 * exactly what NextAuth's middleware.ts does before the React app ever boots.
 * This makes page content invisible to a headless crawler — the correct Raiken
 * behaviour is to detect the pattern and emit an auth-blocker handoff rather
 * than a generic "no pages discovered" error.
 *
 * Usage:  node server.mjs [port]
 * Default port: 5100
 */

import http from "node:http";

const PORT = parseInt(process.argv[2] ?? "5100", 10);

/** Paths that NextAuth exposes without a session cookie. */
const PUBLIC_PATHS = new Set(["/auth/login", "/auth/error", "/auth/verify-request"]);

const LOGIN_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Sign In</title>
  <style>
    body { font-family: system-ui, sans-serif; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,.1);
            width: 360px; }
    h1 { margin: 0 0 1.5rem; font-size: 1.5rem; }
    label { display: block; font-size: .875rem; margin-bottom: .25rem; }
    input { width: 100%; box-sizing: border-box; padding: .5rem .75rem; border: 1px solid #ccc;
            border-radius: 4px; margin-bottom: 1rem; font-size: 1rem; }
    button { width: 100%; padding: .625rem; background: #2563eb; color: white; border: none;
             border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign In</h1>
    <form method="POST" action="/auth/callback/credentials" data-testid="login-form">
      <label for="email">Email</label>
      <input id="email" type="email" name="email" placeholder="you@example.com"
             data-testid="email-input" autocomplete="email" required />
      <label for="password">Password</label>
      <input id="password" type="password" name="password"
             data-testid="password-input" autocomplete="current-password" required />
      <button type="submit" data-testid="login-submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (PUBLIC_PATHS.has(url.pathname)) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(LOGIN_PAGE);
        return;
    }

    // Middleware redirect — same pattern as NextAuth's middleware.ts
    res.writeHead(302, { Location: "/auth/login" });
    res.end();
});

server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        // Another instance (e.g. a parallel test worker) is already listening.
        // Exit cleanly so the test harness can reuse that existing server.
        process.exit(0);
    }
    throw err;
});

server.listen(PORT, "127.0.0.1", () => {
    // Write a single "ready" line so the test harness can detect startup.
    process.stdout.write(`READY http://localhost:${PORT}\n`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
