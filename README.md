# PR Swipe

Review pull requests like a dating app. An OpenComputer agent reviews every open PR in a repo; you swipe right to merge, left to close, or leave a comment.

- `opencomputer/agents/pr-swipe/` — the agent. Managed GitHub App connection (`githubApp`), the built-in `shell` tool, and a `report` result tool. One agent with three modes picked from the turn payload:
  - `list`: `gh pr list` → `report {kind: "prs"}`
  - `review`: clones the repo, reads the diff and every changed file in context, follows callers, checks CI (and failing logs), runs fast tests, verifies each finding → `report {kind: "review"}` (Opus 5.5)
  - `act`: runs exactly one `gh pr merge|close|comment` and confirms the new state → `report {kind: "action"}`
  - `sweep` (schedule `sweep`, every 15 min): lists every repo the GitHub App can reach and every open non-draft PR, then `queue_reviews` starts a review session per PR through the management API (secret `OC_API_KEY`, ≤5 per repo per run). Reviews are keyed `pr-swipe:review:<repo>#<pr>@<headSha>`, the same key the web app uses, so each commit is reviewed once and a new push is reviewed again.
- `web/` — a dependency-free Node server plus a vanilla JS swipe UI. The server keeps the OpenComputer API key and proxies the management API (`/sessions`, `/sessions/<id>/turns`, `/sessions/<id>/events`, `/projects/<p>/github/...`). Each list/review/action is its own session, labelled `app=pr-swipe kind=<…> repo=<…> pr=<…>`, so reloading reuses finished reviews.

## Run

```bash
npm ci
npx opencomputer login
npx opencomputer deploy          # project pr-swipe (single environment: default)
npm run web                      # http://127.0.0.1:8791
```

Set the sweep's key once: `printf %s "$KEY" | npx opencomputer secrets set OC_API_KEY --value-stdin`.

Open the page and choose **Connect GitHub** (same flow as `opencomputer github connect`): install the OpenComputer GitHub App and pick the repos it may touch. That selection is the agent's whole repository boundary.

`http://127.0.0.1:8791/?demo` runs the UI on sample data without GitHub or a model.

## Safety

- Every swipe waits 5 seconds with an Undo before anything runs.
- Review turns are read-only by instruction; only `act` turns run GitHub writes, and only the one command the swipe asked for.
- Merges respect branch protection: a blocked merge comes back as an error with a "Put back" button.
- The GitHub App needs `contents: write` to merge, `pull_requests`/`issues: write` to close and comment, `checks`/`actions: read` for CI.

The deck opens on reviews the sweep already finished (each review stores its card's front), then reconciles with a live PR list: merged/closed PRs drop out, new PRs and new commits get reviewed.

The model is `anthropic/claude-sonnet-4.6` everywhere for now: OpenComputer's Workerd runtime rejects any other model. Switch review mode back to `anthropic/claude-opus-5.5` when it allows it.

`.env` (git-ignored) can hold `OPENCOMPUTER_API_KEY` for a different account than your global login; the server loads it, and `npm run oc -- <command>` runs the CLI with it.

Environment overrides for the server: `PORT`, `OPENCOMPUTER_API_KEY`, `OPENCOMPUTER_PROJECT`, `OPENCOMPUTER_ENVIRONMENT`.
