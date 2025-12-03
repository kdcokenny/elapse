# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Run with hot reload
bun run start        # Run production
bun test             # Run all tests
bun test tests/core/filters.test.ts  # Run single test file
bun run check        # Lint and type check
bun run check:biome  # Biome only (lint)
bun run check:types  # TypeScript only
bun run biome check --write . # Auto-fix lint/format
```

## Architecture

Elapse is an AI-powered standup bot using an **Ingest → Digest → Report** pipeline:

```
GitHub Push → Probot → BullMQ → AI Translation → Redis → Daily Summary → Discord
```

### Data Flow

1. **Ingest (`webhook.ts`)**: Probot receives GitHub push webhooks, filters commits using `core/filters.ts`, queues jobs to BullMQ
2. **Digest (`worker.ts`)**: BullMQ worker fetches diffs via Octokit, calls `ai.ts` to translate to business-value sentences, stores in Redis
3. **Report (`reporter.ts`)**: BullMQ scheduled job (9 AM) aggregates translations, generates narrative summary, posts to Discord

### Key Modules

- **`src/core/`**: Pure functions for filtering, prompts, and formatting (highly testable, no side effects)
- **`src/index.ts`**: Entry point that wires Probot server, BullMQ queue/workers, and shutdown handlers
- **`src/redis.ts`**: Shared Redis connection + storage helpers for daily translations (`elapse:day:{date}:{user}`)

### Single Process Design

All components (Probot server, digest worker, report worker) run in the same process. Shutdown handlers are registered in LIFO order to ensure proper cleanup.

## Code Style

- Biome with tabs, double quotes
- ESNext modules (extensionless imports)
- Error classes in `errors.ts`: `RetryableError` (BullMQ retries) vs `NonRetryableError` (fail immediately)
