# Elapse

> **Turn code into context.**
> The AI-powered standup bot that translates raw git activity into stakeholder-ready updates.

![Bun](https://img.shields.io/badge/Runtime-Bun-black?logo=bun)
![Docker](https://img.shields.io/badge/Deploy-Docker-blue?logo=docker)
![License](https://img.shields.io/badge/License-MIT-green)

## The Problem

Most standup bots are **Vitamins**: they just nag you to type what you did yesterday.
Elapse is a **Painkiller**: it watches your code, analyzes the diffs, and writes the update for you.

It solves the **Translation Gap**:
- **Dev types:** `fix: update reducer logic`
- **Manager reads:** "What does this mean?"
- **Elapse writes:** "Fixed a race condition in the checkout flow, preventing double-charges."

## Features

- **Diff-Aware Intelligence:** It doesn't trust commit messages. It reads the code diffs to understand what actually changed.
- **Daily & Weekly Reports:** Get daily standups and executive-ready weekly rollups with RAG status indicators.
- **Blocker Detection:** Automatically surfaces PRs with `CHANGES_REQUESTED` reviews or stale review requests.
- **Zero Metrics:** No commit counting. No velocity tracking. No spyware. Just visibility.
- **Real-Time Ingestion:** Processes webhooks instantly via Redis queues; no massive API bursts in the morning.
- **One-Click Setup:** No manual GitHub App configuration. Just deploy and click a button.
- **Self-Hostable:** Runs on your VPS with a single `docker compose up`.
- **Model Agnostic:** Supports Google Gemini (default), OpenAI, Anthropic via Vercel AI SDK.

## Quick Start

### Option 1: Docker

```bash
git clone https://github.com/kdcokenny/elapse.git
cd elapse/deploy/docker
cp ../../.env.example .env
# Edit .env with your values
docker compose up -d
```

Visit `http://localhost:3000` to complete the GitHub App setup.

See [`deploy/docker/`](./deploy/docker/) for the full guide.

### Option 2: Dokploy

1. Create a Docker Compose service in Dokploy
2. Set compose file to `deploy/dokploy/compose.yml`
3. Add environment variables
4. Deploy and configure domain

See [`deploy/dokploy/`](./deploy/dokploy/) for the full guide.

## Configuration

### Core Settings

| Variable | Description | Required |
|----------|-------------|----------|
| `GOOGLE_GENERATIVE_AI_API_KEY` | Your Gemini API key | Yes |
| `DISCORD_WEBHOOK_URL` | Default webhook for all reports | Yes |
| `PROJECT_CONTEXT` | Describes your product so AI understands business value | No |
| `TEAM_TIMEZONE` | Timezone for reports (IANA format) | No (default: `America/New_York`) |
| `LLM_MODEL_NAME` | AI model to use | No (default: `gemini-flash-latest`) |
| `LOG_LEVEL` | Logging verbosity | No (default: `info`) |

### Report Scheduling

| Variable | Description | Default |
|----------|-------------|---------|
| `REPORT_CADENCE` | Report frequency: `daily`, `weekly`, or `both` | `weekly` |
| `DAILY_SCHEDULE` | Cron for daily reports | `0 9 * * 1-5` (9 AM Mon-Fri) |
| `WEEKLY_SCHEDULE` | Cron for weekly reports | `0 16 * * 5` (4 PM Friday) |

### Webhook Overrides

Send daily and weekly reports to different Discord channels:

| Variable | Description |
|----------|-------------|
| `DISCORD_WEBHOOK_URL` | Base webhook (used if overrides not set) |
| `DISCORD_WEBHOOK_URL_DAILY` | Override for daily reports |
| `DISCORD_WEBHOOK_URL_WEEKLY` | Override for weekly reports |

### Blocker Detection

| Variable | Description | Default |
|----------|-------------|---------|
| `STALE_REVIEW_THRESHOLD_DAYS` | Days before a pending review is "stale" | `3` |
| `WEEKLY_RAG_BLOCKER_THRESHOLD` | Days before a blocker triggers 🔴 status | `7` |

GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) are configured via the one-click setup wizard.

## Deployment

Elapse requires long-running processes and Redis. See the [`deploy/`](./deploy/) directory for platform-specific guides:

| Platform | Guide |
|----------|-------|
| Docker | [`deploy/docker/`](./deploy/docker/) |
| Dokploy | [`deploy/dokploy/`](./deploy/dokploy/) |

More platforms may be added in the future.

## Architecture

Elapse uses an **Ingest → Digest → Report** pipeline:

```
GitHub Push → Probot → BullMQ → AI Translation → Redis → Reports → Discord
```

1. **Ingest (Probot):** Listens for GitHub push webhooks. Filters out bots, lockfiles, and merge commits. Pushes jobs to Redis queue.

2. **Digest (Worker):** Fetches the diff for each commit. Uses AI to translate changes into a single business-value sentence. Stores in Redis.

3. **Report (Scheduler):** Generates daily and/or weekly reports. Posts to Discord.

## Reports

### Daily Reports

Generated at 9 AM on weekdays. Includes:
- Narrative summary of the day's work
- Grouped by PR with translations
- Blocker callouts for PRs with `CHANGES_REQUESTED` or stale reviews
- "Awaiting Review" section for pending reviews

### Weekly Reports

Executive-ready summaries generated on Fridays. Includes:

- **RAG Status:** 🟢 On Track / 🟡 At Risk / 🔴 Blocked
- **Executive Summary:** 1-2 sentence top-line
- **Shipped This Week:** Thematically grouped PRs (3-5 groups)
- **Blockers & Risks:** Active blockers with age and mentions
- **Help Needed:** Escalations requiring action
- **Carrying Into Next Week:** In-progress work

**RAG Status Logic:**
| Status | Condition |
|--------|-----------|
| 🟢 Green | No active blockers, < 3 stale reviews |
| 🟡 Yellow | Any active blocker, OR 3+ stale reviews |
| 🔴 Red | Any blocker ≥ 7 days, OR 3+ active blockers |

**Weekend Handling:** Commits pushed on Saturday/Sunday are attributed to Monday's daily report and the following week's weekly report.

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Run tests
bun test

# Lint and type check
bun run check
```

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Framework:** [Probot](https://probot.github.io/)
- **Queue:** [BullMQ](https://docs.bullmq.io/)
- **AI:** [Vercel AI SDK](https://sdk.vercel.ai/)
- **Logging:** [Pino](https://getpino.io/)

## API Endpoints

- `POST /api/github/webhooks` - GitHub webhook receiver
- `GET /health` - Health check endpoint

## Filtering Rules

Elapse automatically filters out noise:

- **Bot commits:** dependabot, renovate, github-actions
- **Lockfile-only:** package-lock.json, yarn.lock, etc.
- **Merge commits:** `Merge branch...`, `Merge pull request...`
- **Vague messages:** `fix`, `wip`, `update` (AI relies on diff instead)

## Blocker Detection

Elapse detects blockers automatically without requiring labels:

| Blocker Type | Detection Method |
|--------------|------------------|
| Changes Requested | PR has a review with `CHANGES_REQUESTED` state |
| Stale Review | Review requested but no response within threshold (default: 3 days) |

Blockers are surfaced in daily reports and aggregated in weekly reports with age tracking.

## Known Limitations

- **Pre-existing PRs:** Pull requests that were already open when you install Elapse will be tracked once they receive new commits. Full context (PR numbers, blockers) becomes complete within 1-2 weeks of normal development activity.

## License

MIT
