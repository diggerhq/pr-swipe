# 💘 PR Swipe

**Review pull requests like a dating app.** An agent reviews every open PR in your connected repos before you show up. You swipe right to merge, left to close, or leave a comment.

PR Swipe is an open-source template for [OpenComputer](https://opencomputer.dev) Serverless Agents.

- **Try the demo:** https://pr-swipe.vercel.app (sample PRs, nothing touches GitHub)
- **Deploy your own:** [![Deploy on OpenComputer](https://img.shields.io/badge/Deploy%20on-OpenComputer-ff4f7b)](https://app.opencomputer.dev/new?repository-url=https%3A%2F%2Fgithub.com%2Fdiggerhq%2Fpr-swipe)

## What it does

1. **Connect GitHub.** You install OpenComputer's GitHub App and pick repos. That selection is everything the agent can reach.
2. **The agent reviews in the background.** Every 15 minutes a schedule finds new PRs and new commits and reviews each one in its own sandbox. It clones the repo, reads the diff and every changed file in full, follows callers, checks CI (including failing logs), runs fast tests, and verifies each finding before reporting it. The result is a verdict (`merge`, `needs_work`, `close`), a risk level, green flags, and red flags with file and line.
3. **You swipe.** Right merges (squash, merge commit or rebase), left closes, 💬 comments (one click inserts the agent's findings). Every swipe waits 5 seconds so you can undo. Branch protection still applies; a blocked merge comes back as an error with a "Put back" button.

Reviews are keyed to the PR's head commit, so each commit is reviewed once whether the schedule or the app asks first. The app opens on finished reviews, then reconciles with a live PR list in the background.

## What OpenComputer does here

| | |
|---|---|
| **Agent loop** | `agent.ts` returns instructions per mode; OpenComputer calls the model, runs tools and loops. |
| **A computer per review** | Each review gets an isolated Linux sandbox with `git` and `gh`. |
| **GitHub App connection** | `githubApp()` gives every command a short-lived installation token. No GitHub token in your code. |
| **Durable sessions** | Each list, review and swipe is a session with an event log and a typed result (`report` tool). That is the app's database. |
| **Schedules** | `schedules/sweep.ts` runs the review sweep every 15 minutes. |
| **Secrets at the edge** | The sweep's API key is attached at OpenComputer's outbound edge; the agent never sees it. |

## Deploy your own

1. **Deploy the template**: click the button above. OpenComputer creates a project from this repo and deploys the agent.
2. **Connect GitHub** in the project's **Connections** tab (or with `npx opencomputer github connect`, or the app's Connect GitHub button). Select the repos to review.
3. **Optional, for background reviews:** set an OpenComputer API key as the `OC_API_KEY` secret. Without it, reviews start when you open the app.
   ```bash
   printf %s "$OPENCOMPUTER_API_KEY" | npx opencomputer secrets set OC_API_KEY --value-stdin
   ```
4. **Run the app.**
   - Locally: `npm ci && npx opencomputer login && npm run web`, then open http://127.0.0.1:8791/app. It uses your CLI login and the linked project in `.opencomputer/project.json`.
   - On Vercel: import this repo and set the environment variables below.

### Vercel environment variables

| Variable | |
|---|---|
| `OPENCOMPUTER_API_KEY` | API key for the account that owns the project |
| `OPENCOMPUTER_PROJECT` | Project id (`prj_…`) |
| `APP_PASSWORD` | Required for live mode on a hosted deployment, because the app can merge and close PRs |
| `OPENCOMPUTER_ENVIRONMENT` | Optional, default `default` |
| `PR_SWIPE_AGENT` | Optional, default `pr-swipe` |

Without `OPENCOMPUTER_API_KEY` and `APP_PASSWORD`, a Vercel deployment serves the landing page and the demo only, which is how the hosted demo runs.

## Use it without the app

The agent also answers in the OpenComputer playground or CLI:

```bash
npx opencomputer session "Review acme/api#12"
npx opencomputer session "List PRs in acme/api"
npx opencomputer session "sweep"
```

## Layout

```
opencomputer/
  project.ts
  agents/pr-swipe/
    agent.ts                 list · review · act · sweep, selected by payload (or text)
    tools/report.ts          typed session result the app renders
    tools/queue-reviews.ts   starts review sessions for the sweep (OC_API_KEY)
    schedules/sweep.ts       every 15 minutes
web/
  handler.mjs                /api routes: proxies the sessions API, keeps the key server-side
  server.mjs                 local server (npm run web)
  public/index.html          landing page
  public/app.html, app.js    the swipe app (?demo for sample data)
api/index.js                 the same handler as a Vercel function
oc-template.toml             one-click template manifest
```

## Notes

- **Model:** every mode uses `anthropic/claude-sonnet-4.6` for now, because the OpenComputer runtime currently accepts only that model. Switch review mode to a stronger model in `agent.ts` when it is available.
- **Permissions:** the GitHub App connection asks for `contents: write` (merge), `pull_requests` and `issues: write` (close, comment), and `checks` and `actions: read` (CI).
- **Safety:** review turns are read-only by instruction; only `act` turns write, and only the single `gh` command the swipe asked for. PR content is treated as untrusted data.
- `.env` (git-ignored) can hold `OPENCOMPUTER_API_KEY` for a different account than your global login; `npm run oc -- <command>` runs the CLI with it.

MIT licensed.
