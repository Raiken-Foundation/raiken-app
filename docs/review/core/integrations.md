# Core Review — integrations

**Scope:** `libs/core/src/integrations/` (8 files, ~1,465 lines — GitHub/Jira/Linear ticket providers, branch parsing, sync, ticket analysis)
**Method:** delegated line-by-line review (all files read fully; 3 specs skimmed). Report-first — no changes made.

## Findings

| Severity | Location | Issue | Why it matters | Fix direction |
|---|---|---|---|---|
| high | libs/core/src/integrations/sync.ts:189-194 (trigger at 78-84) | tryFindPRForBranch cannot match a PR to the branch (its own comment admits head-branch info is absent); it returns the FIRST assigned ticket with changedFiles, else myTickets[0] | On any branch without a parseable ticket ID (feature/add-login), sync attributes an arbitrary, unrelated assigned ticket to the current branch; the analyzer produces impact analysis + test suggestions for the WRONG ticket, persisted as the current ticket in .raiken/. source:"pr" is reported even when the fallback returns a plain issue | GET /repos/{o}/{r}/pulls?head={owner}:{branch}, or drop the fallback and return null with a clear reason |
| high | libs/core/src/integrations/ticket-analyzer.ts:191-196 (and 286) | Untrusted ticket title/description/labels (and PR file paths, 66-71) interpolated raw into the LLM system+user prompt with no delimiting, sanitization, or treat-as-data instruction; :286 embeds ticket.title verbatim into suggestedPrompt (quotes break the quoting) | Ticket text is attacker-controllable on public repos; the output feeds an agent that GENERATES AND RUNS Playwright tests — a crafted title becomes an instruction in the generation prompt. Classic indirect prompt injection | Wrap ticket content in labeled blocks; injection-resistant system guidance; escape/strip control text in suggestedPrompt; cap description length |
| medium | libs/core/src/integrations/sync.ts:64-68 with 118 | parseTicketFromBranch detects a provider per ticket ID, but sync ignores parsed.provider and always uses config?.provider ?? "github" | A Jira/Linear user who hasn't set integrations.provider gets RAI-123 fetched against GitHub → Invalid GitHub ticket ID → warn → cascades into the broken PR-fallback heuristic. The detection exists (surfaced in bootstrap logs) but the only consumer discards it | Use parsed.provider when config.provider is unset (or validate the ID shape matches the active provider) |
| medium | libs/core/src/integrations/github-provider.ts:118-120, 147-149, 173-175 | Catch-all catch { return [] / null } in getChangedFiles, fetchPR, fetchIssue | A 403 rate-limit, 401 expired PAT, or network failure becomes [] changedFiles (PR analyzed as if no diff → wrong suggestions) or a misleading not-found error; rate-limit errors are exactly the ones being swallowed | Only swallow 404; rethrow others (or typed errors with status) |
| medium | libs/core/src/integrations/sync.ts:195-197 | tryFindPRForBranch catches every error and returns null with no warning | Sync reports empty success with no signal the PR lookup failed (auth, rate limit, network) | Log the reason; surface in SyncResult |
| medium | github-provider.ts:219, jira-provider.ts:105, linear-provider.ts:145 | No AbortSignal/timeout on any fetch in any provider | A hung provider connection hangs the CLI indefinitely | AbortSignal.timeout(≈10-30s) on all fetches |
| medium | github-provider.ts:76,108; jira-provider.ts:41; linear-provider.ts:95 | No pagination anywhere: issues per_page=20, PR files per_page=100, Jira maxResults=20 (total ignored), Linear first:20 | Users with >20 tickets or PRs with >100 changed files get silently truncated results; the PR heuristic may miss the real PR | Follow Link rel=next / Jira startAt / Linear pageInfo — or at least log truncation |
| medium | linear-provider.ts:85-93; jira-provider.ts:37 | teamKey string-interpolated into the GraphQL query; projectKey into JQL | Quote/special char in config breaks the query — the canonical injection pattern, real the moment config is ever imported/shared; the Linear query uses variables elsewhere (inconsistent) | $teamKey GraphQL variable; JQL-escape or parameterize |
| medium | libs/core/src/integrations/branch-parser.ts:66 | SSH remote regex [:/](owner)/(repo) matches any SSH host; only HTTPS checks github.com | A GitLab SSH remote yields {owner:"sub", repo:"repo"} → sync queries the wrong repo on api.github.com | Require github.com in the SSH match |
| low | branch-parser.ts:24 with 122-127 (dead 129-134) | LINEAR_PATTERN is a strict subset of JIRA_PATTERN which runs first — Linear unreachable in auto-detect; docstring contradicts behavior (pinned in spec) | Misleading docs + dead code; Linear users get jira-labeled IDs | Narrow JIRA_PATTERN or drop LINEAR_PATTERN; fix the docstring |
| low | branch-parser.ts:35-37 | Comment promises a rev-parse fallback that doesn't exist | Misleads maintainers about detached-HEAD | Delete or implement |
| low | github-provider.ts:194 | First linked-issue regex redundant (subset of the second pattern; Set dedups) | Dead code | Drop |
| low | github-provider.ts:140 | assignee: pr.assignee?.login ?? pr.user?.login — falls back to the PR AUTHOR | Assignee ≠ author; misattribution downstream | Only report a real assignee |
| low | jira-provider.ts:97 | ADF join separators inverted: inline children join with \\n, sibling paragraphs with " " | Descriptions with links get spurious newlines; multi-paragraph collapses — mangled LLM input | Doc-level children \\n; inline runs ""/" " |
| low | github-provider.ts:105 (vs 52-55) | getChangedFiles parses ticketId with no NaN guard unlike getTicket | /pulls/NaN/files → 404 → swallowed → [] | Mirror the guard |
| low | jira-provider.ts:31; github-provider.ts:76 | ticketId interpolated unencoded into the Jira path; user login unencoded | Special chars → malformed requests | encodeURIComponent |
| note | github-provider.ts:80-85 | N+1 sequential getChangedFiles per PR (up to 20 extra requests); no 403/429/Retry-After handling | One anonymous sync can burn ~22 of 60 req/hr, then fail swallowed | Parallelize with cap; rate-limit backoff |
| note | jira-provider.ts:41; github-provider.ts:23 | issuetype fetched but unused; bare-number pattern false-positives on dates (release/2024-01-15 → ticket "01") | Dead fetch; untested false-positive class | Remove; require non-zero-padded numbers |

Secret handling: CLEAN — all three providers send credentials via Authorization headers only; no tokens in URLs, logs, or thrown errors (error bodies are provider-sourced).

## Strengths
- Clean credential transport across all three providers — headers only, never in URLs/query strings/console.warn.
- Untrusted PR file paths flow into parameterized SQL (graph repositories use ? placeholders throughout) — no SQL-injection path from ticket data.
- Correct, current API usage: X-GitHub-Api-Version + vnd.github+json, Jira REST v3, Linear GraphQL with proper top-level errors handling.
- Disciplined resource handling: try/finally db.close() in semanticSearch and GraphQueryService; bounded inputs (slice(0,200) files, slice(0,25) symbols).
- Honest engineering culture: bug-pin tests document known footguns (regex overlap, version-number false positives) instead of hiding them.

## Test-coverage observations
- ZERO specs for jira-provider.ts, linear-provider.ts, and ticket-analyzer.ts — JQL construction, the ADF extractor, GraphQL building (incl. teamKey interpolation), and prompt construction entirely untested.
- No pagination/truncation tests anywhere; no rate-limit/timeout/mid-getMyTickets failure tests.
- No test pins that sync ignores parsed.provider — all routing tests set config.provider explicitly, so the default-GitHub mismatch is invisible.
- tryFindPRForBranch tested only single-ticket happy path; arbitrary selection and issue-as-source:"pr" uncovered.
- No injection-shaped tests (ticket titles with quotes/instructions reaching the prompt).
- branch-parser: custom pattern without capture group and date-style branches untested.

## Verdict
**needs fixes** — two high findings on realistic paths (arbitrary-ticket attribution in the PR fallback; indirect prompt injection flowing into an agent that generates and runs code), plus systemic error-swallowing, missing timeouts, and no pagination across all three providers.
