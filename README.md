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
- **Zero Metrics:** No commit counting. No velocity tracking. No spyware. Just visibility.
- **Real-Time Ingestion:** Processes webhooks instantly via Redis queues; no massive API bursts in the morning.
- **Self-Hostable:** Runs on your VPS with a single `docker-compose up`.
- **Model Agnostic:** Supports Google Gemini (default), OpenAI, Anthropic via Vercel AI SDK.

## Quick Start (Self-Hosted)

### Prerequisites

- [Bun](https://bun.sh) v1.1+ (or Docker)
- Redis
- A GitHub App

### 1. Clone and Configure

```bash
git clone https://github.com/yourusername/elapse.git
cd elapse
cp .env.example .env
```

Edit `.env` with your credentials:
- `APP_ID`, `PRIVATE_KEY`, `WEBHOOK_SECRET` - from your GitHub App
- `GOOGLE_GENERATIVE_AI_API_KEY` - your Gemini API key
- `DISCORD_WEBHOOK_URL` - where to post standups
- `PROJECT_CONTEXT` - describe your product (e.g., "A dental SaaS platform")

### 2. Run with Docker

```bash
docker-compose up -d
```

### 3. Create GitHub App

1. Go to [GitHub Developer Settings](https://github.com/settings/apps)
2. Create a new GitHub App with:
   - **Webhook URL:** `https://your-domain.com/api/github/webhooks`
   - **Permissions:**
     - Repository contents: Read
     - Metadata: Read
   - **Subscribe to events:** Push
3. Generate a private key and add it to `.env`
4. Install the app on your repositories

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `PROJECT_CONTEXT` | Describes your product so AI understands business value | `"A software project"` |
| `TEAM_TIMEZONE` | Timezone for the 9 AM report (IANA format) | `America/New_York` |
| `SCHEDULE` | Cron expression for reports | `0 9 * * 1-5` (9 AM Mon-Fri) |
| `DISCORD_WEBHOOK_URL` | Where to post the standup | Required |
| `LLM_MODEL_NAME` | AI model to use | `gemini-flash-latest` |
| `LOG_LEVEL` | Logging verbosity | `info` |

## Architecture

Elapse uses an **Ingest → Digest → Report** pipeline:

```
GitHub Push → Probot → BullMQ → AI Translation → Redis → Daily Summary → Discord
```

1. **Ingest (Probot):** Listens for GitHub push webhooks. Filters out bots, lockfiles, and merge commits. Pushes jobs to Redis queue.

2. **Digest (Worker):** Fetches the diff for each commit. Uses AI to translate changes into a single business-value sentence. Stores in Redis.

3. **Report (Scheduler):** Runs at 9:00 AM. Aggregates the day's translations into a narrative summary. Posts to Discord.

## Development

```bash
# Install dependencies
bun install

# Run in development mode
bun run dev

# Run tests
bun test

# Type check
bun run typecheck
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

## License

MIT
