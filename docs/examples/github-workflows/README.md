# Raiken GitHub Actions templates

These workflows are reference implementations that consumers of Raiken can
copy into their own repos. They are NOT used by the Raiken codebase
itself; they live in `docs/examples/` so the maintainer story is "vendor
a copy and adapt", not "depend on a published action".

| File                | Purpose                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `raiken-ci.yml`     | Runs `raiken ci` on every PR, publishes JUnit/JSON reports, comments the impact summary. |
| `raiken-cover.yml`  | Listens for `/raiken cover <target>` PR comments and commits a drafted test back.        |

## Usage

1. Copy the file into your project at `.github/workflows/<filename>`.
2. Add the required secrets (see the comment block at the top of each file).
3. Open a PR — the workflow runs automatically.

## Notes

- Both workflows assume `pnpm`. Replace with `npm` / `yarn` as needed; the only
  invariant is that `raiken` is on the `PATH` after install.
- `raiken-cover.yml` only triggers on PR comments because it needs to push a
  commit back to the PR branch. The author + reviewer permission model is the
  GitHub default: anyone who can comment can trigger it, so treat the LLM
  budget accordingly.
- The cover workflow falls back to scaffold mode (no LLM call) if
  `OPENROUTER_API_KEY` is not set; you'll still get a TODO-shaped test file
  committed back so the loop is observable.
