# Project Context

## Purpose

Elapse is an AI-powered standup bot that translates raw git activity into stakeholder-ready updates. It solves the "Translation Gap" between developer commit messages and business-value summaries that managers and stakeholders can understand.

**Core goals:**
- Automatically generate daily and weekly reports from GitHub activity
- Translate code diffs into business-value sentences (not just commit messages)
- Surface blockers (CHANGES_REQUESTED reviews, stale review requests)
- Zero metrics/spyware - just visibility into what's shipping

## Tech Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict mode, ESNext)
- **Framework:** Probot (GitHub webhook handling)
- **Queue:** BullMQ (job processing with Redis)
- **Database:** Redis (via ioredis)
- **AI:** Vercel AI SDK with Google Gemini (default), supports OpenAI/Anthropic
- **Logging:** Pino
- **Validation:** Zod
- **Output:** Discord webhooks
- **Linting/Formatting:** Biome

## Project Conventions

### Code Style

- **Indentation:** Tabs (Biome enforced)
- **Quotes:** Double quotes (Biome enforced)
- **Modules:** ESNext with extensionless imports
- **TypeScript:** Strict mode with `noUncheckedIndexedAccess`
- **Imports:** Auto-organized by Biome

### Architecture Patterns

**Pipeline: Ingest → Digest → Report**

1. **Ingest** (`webhook.ts`): Probot receives GitHub push webhooks, filters commits (bots, lockfiles, merge commits), queues jobs to BullMQ
2. **Digest** (`worker.ts`): Fetches diffs via Octokit, AI translates changes to business-value sentences, stores in Redis
3. **Report** (`daily-reporter.ts`, `weekly-reporter.ts`): Scheduled jobs generate reports, posts to Discord

**Key patterns:**
- Pure functions in `src/core/` (highly testable, no side effects)
- Single process design: Probot server + BullMQ workers in same process
- Redis keys: `elapse:day:{date}:{user}` for daily translations

**Error handling:**
- `RetryableError`: BullMQ retries with exponential backoff
- `NonRetryableError`: Fail immediately, no retry

### Testing Strategy

- **Test runner:** Bun test
- **Core tests:** `tests/core/` - Unit tests for pure functions
- **E2E tests:** `tests/e2e/` - Integration tests with real/simulated data
- **Fixtures:** `tests/fixtures/` - Synthetic and real-world test data

**Commands:**
- `bun test` - Run core tests
- `bun test:all` - Run all tests
- `bun test:e2e` - Run E2E tests (180s timeout)

### Git Workflow

- Conventional commit messages preferred
- Feature branches merged to main
- CI runs `bun run check` (lint + type check)

## Domain Context

**Key concepts:**
- **Translation:** Converting code diffs to business-value sentences
- **Digest:** Stored summary of a commit/PR's changes
- **Blocker:** PR with CHANGES_REQUESTED review or stale review request
- **RAG Status:** Weekly report indicator (🟢 On Track / 🟡 At Risk / 🔴 Blocked)
- **Weekend rollover:** Sat/Sun commits attributed to Monday's daily report

**Report types:**
- **Daily (9 AM Mon-Fri):** Narrative summary, grouped by PR, blocker callouts
- **Weekly (4 PM Friday):** Executive summary, RAG status, shipped items, blockers, help needed

**Filtering rules:**
- Bot commits filtered (dependabot, renovate, github-actions)
- Lockfile-only commits filtered
- Merge commits filtered
- AI reads diffs, not commit messages, for accuracy

## Important Constraints

- **Single process:** Server and workers run in same process
- **Redis required:** BullMQ and data storage depend on Redis
- **Long-running:** Requires persistent process (not serverless)
- **GitHub App:** Requires GitHub App credentials for webhook access
- **Model agnostic:** Must work with any Vercel AI SDK-supported model

## External Dependencies

| Service | Purpose | SDK/Client |
|---------|---------|------------|
| GitHub API | Fetch diffs, PR info, review states | Octokit (via Probot) |
| Redis | Job queue, data storage | ioredis, BullMQ |
| AI Provider | Translate diffs to business summaries | Vercel AI SDK |
| Discord | Report delivery | Webhook (fetch) |

**Environment variables (key ones):**
- `GOOGLE_GENERATIVE_AI_API_KEY` - AI provider key
- `DISCORD_WEBHOOK_URL` - Report destination
- `REDIS_URL` - Redis connection (default: localhost:6379)
- `TEAM_TIMEZONE` - Report timezone (default: America/New_York)
- `REPORT_CADENCE` - `daily`, `weekly`, or `both`
