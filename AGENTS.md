<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# AGENTS.md

## Commands
- `bun run dev` - Start dev server with hot reload
- `bun run start` - Run production
- `bun test` - Run all tests
- `bun test tests/core/filters.test.ts` - Run single test file
- `bun run check` - Lint and type check
- `bun run check:biome` - Biome only (lint)
- `bun run check:types` - TypeScript only
- `bun run biome check --write .` - Auto-fix lint/format

## Code Philosophy
- **Elegant Simplicity**: Write the simplest code that solves the problem. Avoid premature abstraction, unnecessary indirection, and over-engineering. If a solution feels complex, step back and find a simpler approach.
- **Fail Fast**: Validate inputs early and throw explicit errors immediately when something is wrong. Never silently swallow errors or continue with invalid state. Use guard clauses at function entry points.
- **Explicit over Implicit**: Prefer clear, obvious code over clever code. Future readers (including AI) should understand intent without mental gymnastics.

## Architecture
Elapse is an AI-powered standup bot: **Ingest → Digest → Report**
- **Ingest** (`webhook.ts`): Probot receives GitHub push webhooks, filters commits, queues to BullMQ
- **Digest** (`worker.ts`): Fetches diffs via Octokit, AI translates to business-value sentences, stores in Redis
- **Report** (`daily-reporter.ts`, `weekly-reporter.ts`): Scheduled jobs generate daily (9 AM) or weekly (Fri 4 PM) reports, posts to Discord

## Code Style (Biome enforced)
- **Indentation**: Tabs
- **Quotes**: Double quotes
- **Modules**: ESNext (extensionless imports)
- **Errors**: `RetryableError` (BullMQ retries) vs `NonRetryableError` (fail immediately)

## Conventions
- Pure functions in `src/core/` (highly testable, no side effects)
- Single process design: Probot server + BullMQ workers in same process
- Redis keys: `elapse:day:{date}:{user}` for daily translations

## Research & Documentation
- When you need to search docs, use `context7` tools.
- If you are unsure how to do something, use `gh_grep` to search code examples from GitHub.
