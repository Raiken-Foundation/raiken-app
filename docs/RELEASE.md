# Releasing the `raiken` npm package

The published package is built from `dist/apps/cli` — a self-contained bundle
(`bin.cjs`, `index.cjs`) plus the dashboard assets in `public/`. Everything else
is installed from the manifest's `dependencies` when a user runs
`npm install -g raiken`.

## One-time / preflight (maintainer machine)

1. **Node 22** — the build must run under the version pinned in `.nvmrc`:

   ```bash
   nvm use 22
   ```

2. **npm login must be valid** — publishing fails with `E401` otherwise:

   ```bash
   npm whoami   # must print your username, not 401
   npm login    # if whoami fails
   ```

3. **npm cache health** — if npm errors with `EPERM ... root-owned files`:

   ```bash
   sudo chown -R $(id -u):$(id -g) ~/.npm
   ```

## Version bump

Two files carry the version and are parity-tested against each other — bump both:

- `apps/cli/package.json` → `"version"`
- `libs/shared/src/lib/version.constant.ts` → `RAIKEN_VERSION`

Verify the parity spec and DB specs still pass after a native-dependency change:

```bash
pnpm --dir libs/shared exec vitest run --config vitest.config.ts
pnpm --dir libs/core exec vitest run --config vitest.config.ts src/database
```

## Publish

```bash
pnpm release        # = cli:build + smoke:cli + npm publish dist/apps/cli
```

`release:prep` alone builds and smoke-tests without publishing. Inspect what
would ship first if you want:

```bash
npm pack --dry-run --cache /tmp/npm-cache-tmp
```

(from `dist/apps/cli` — the `files` allowlist keeps `pnpm-workspace.yaml`,
lockfiles, and `node_modules/` out of the tarball; `node_modules` must stay on
disk for the repo-local `cli:install` flow, but never ships.)

## Post-publish verification

From a clean directory, as a fresh user:

```bash
npm install raiken@latest --cache /tmp/npm-cache-tmp
npx raiken --version
npx raiken doctor
```

Repeat once under Node 24 (`nvm use 24`) — the native deps
(`better-sqlite3@^12`) must install from prebuilds, not source builds.

## Constraints to keep intact

- **`engines.node` is `>=22`** (no upper cap). An upper cap hard-blocks the
  current LTS on pnpm and caused the Node 24 install breakage fixed in 0.7.0.
- **`better-sqlite3` must stay `^12`+** — v11 has no prebuilds for Node 24,
  which made `npm install raiken` fail for every Node 24 user.
- Publishing is append-only: a version, once published, cannot be reused after
  unpublishing. Bump rather than retry the same number.
