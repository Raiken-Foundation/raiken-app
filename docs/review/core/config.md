# Core Review — config

**Scope:** `libs/core/src/config/` (8 files, ~1,665 lines: schema, store, load, patch, auth-state, auth-liveness, auth-credentials, index)
**Method:** direct line-by-line read (agent delegation failed twice; reviewed in-session). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| medium | libs/core/src/config/patch.ts:98 | `--unset-key` builds `clearSecrets: ["ai.apiKey"]` only — never clears `ai.apiKeys.<activeProvider>` | Modern-shape configs (apiKeys map) keep a live key after the user explicitly unsets it; the CLI reports success while the key remains active | Include `ai.apiKeys.${activeProvider}` in clearSecrets (provider resolvable from stored config) |
| medium | libs/core/src/config/auth-liveness.ts:139-156 | `defaultNavigate` uses the shared `BrowserSession.getInstance(projectPath)` singleton and `finally` CLOSES it after each probe | A liveness probe racing an active discovery/browser operation closes the shared browser out from under it (cross-module concern — see browser.md registry-store forceClose finding for the same class) | Use an ephemeral non-registry session for probes, or lease via the registry |
| low | libs/core/src/config/load.ts:161-171 | `loadTestDirectory` returns the raw string; consumers (e.g. doctor/scan.ts:413-415) `path.resolve(projectPath, dir)` with no containment check | A `testDirectory` like "../shared-e2e" scans outside the project | Containment-check via resolvePathWithinProject like other paths |
| low | libs/core/src/config/store.ts:239-240 | Patching a secret leaf with a non-string (null) OVERWRITES the secret with null → `z.string().optional()` rejects it on next validation | Dashboard sends strings, but any API caller can send null and wedge the config | Treat null like blank string ("unchanged"); require clearSecrets to delete |
| low | libs/core/src/config/index.ts:8 | Barrel re-exports auth-liveness, which imports browser/session + site-discovery + agent/memory | Any config import transitively pulls Playwright-adjacent code; config↔site-discovery cycle risk | Move auth-liveness out of the barrel or invert the dependency |
| note | libs/core/src/config/auth-liveness.ts:133-137 | Login-title heuristic misses "Authentication required" (pattern is `authenticate`, not `authenticat\w*`) | Minor false-negative on stale detection | Broaden the pattern |
| note | libs/core/src/config/schema.ts:323-361 | `configExample` omits newer discovery fields (maxRunTimeMs, preserveQueryParams, settleQuietMs, settleMaxMs) and shows different excludePatterns than defaultConfig | Example drift confuses users diffing against defaults | Generate the example from defaultConfig |
| note | libs/core/src/config/load.ts:45-64 | parseSectionPartial silently drops invalid fields (documented; doctor flags invalid JSON/schema separately) | Typos silently become defaults | Surface dropped fields in `raiken status` |
| note | libs/core/src/config/auth-state.ts:96-101 | resolveAuthStorageStateRelativePath returns null for an existing-but-invalid state | Callers can't show where the broken state lives | Separate path resolution from validity check |

Clean: path containment (resolvePathWithinProject is symlink-aware with canonical-ancestor handling — the macOS /tmp case is documented), secret redaction to the API (redactConfig presence-flags design), provider-switch key migration, writeConfigAtomic (async+sync), env-var credential precedence with injection-proof env names.

## Strengths
- `redactConfig`/`PublicRaikenConfig`: secrets never hydrate into dashboard memory — only `*Present` booleans cross the boundary; merge treats blank secret drafts as "unchanged" with opt-in deletion.
- `migrateLegacyKeyOnProviderSwitch` preserves legacy keys per-provider on switch, preventing cross-provider key routing.
- `writeValidatedAuthState` (auth-state.ts:274-300): validate-the-temp-then-rename with 0600 — a bad capture can never clobber a working session.
- `inspectAuthState`'s provable-expiry-only semantics (session cookies can't be judged from the file) is correctly conservative and well documented.

## Test-coverage observations
- config-patch.spec exercises unset (7 mentions) and has apiKeys fixtures — verify explicitly whether unset-key against the apiKeys MAP shape is asserted (the medium finding above needs a regression test).
- No test for the auth-liveness probe colliding with an active BrowserSession (singleton semantics).
- No test that patching null into a secret path leaves the config valid.
- resolvePathWithinProject symlink-escape tests exist in config-store.spec; a testDirectory-traversal case (load.ts consumer path) does not exist.

## Verdict
**minor fixes needed** — the unset-key/apiKeys gap is the one user-visible correctness bug; the liveness-probe session sharing needs a design decision; everything else is hygiene.
