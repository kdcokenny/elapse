# Tasks: Hybrid Thread Approach for Digests

## 1. Discord Integration Layer

- [x] 1.1 Add TypeScript types for Discord embed structure (`src/discord.ts`)
- [x] 1.2 Add TypeScript types for webhook response with message ID
- [x] 1.3 Implement `sendHybridToDiscord()` function with two-phase delivery
- [x] 1.4 Add `?wait=true` query param handling for message ID retrieval
- [x] 1.5 Add `?thread_id=xxx` query param for thread posting
- [x] 1.6 Implement graceful fallback to single message on thread failure
- [x] 1.7 Add unit tests for Discord integration functions

## 2. Formatting Layer - Main Embed

- [x] 2.1 Create `formatMainEmbed()` function in `src/core/formatting.ts`
- [x] 2.2 Implement RAG color calculation (green/yellow/red thresholds)
- [x] 2.3 Add escalation detection logic (blockers > 5 days)
- [x] 2.4 Format embed fields (Shipped count, Blockers count, inline layout)
- [x] 2.5 Add ESCALATION field conditional rendering
- [x] 2.6 Enforce 400 char limit on embed description
- [x] 2.7 Add unit tests for main embed formatting

## 3. Formatting Layer - Thread Content

- [x] 3.1 Create `formatThreadContent()` function for daily reports
- [x] 3.2 Create `formatWeeklyThreadContent()` function for weekly reports
- [x] 3.3 Implement full blocker list with ages and PR links
- [x] 3.4 Implement shipped section with attribution (weekly)
- [x] 3.5 Implement awaiting review section (daily)
- [x] 3.6 Implement help needed section
- [x] 3.7 Implement "Carrying into next week" section (weekly)
- [x] 3.8 Add unit tests for thread content formatting

## 4. Thread Configuration

- [x] 4.1 Add thread naming helper: `getThreadName(type, date)`
- [x] 4.2 Add auto-archive duration constants (1440 daily, 10080 weekly)
- [x] 4.3 Implement thread creation payload with `thread_name` and `auto_archive_duration`
- [x] 4.4 Add unit tests for thread configuration

## 5. Reporter Integration

- [x] 5.1 Update `daily-reporter.ts` to use `sendHybridToDiscord()`
- [x] 5.2 Update `weekly-reporter.ts` to use `sendHybridToDiscord()`
- [x] 5.3 Pass report data to new formatting functions
- [x] 5.4 Add escalation context to reporter data flow

## 6. Testing & Validation

- [x] 6.1 Update E2E tests to use hybrid format (daily thread content)
- [x] 6.2 Update E2E tests to use hybrid format (weekly thread content)
- [x] 6.3 Update validation functions for new thread content format
- [x] 6.4 Add E2E test for fallback behavior on thread failure
- [x] 6.5 Add E2E test for RAG status color thresholds
- [x] 6.6 Manual validation: verify embed renders on Discord mobile and desktop
- [x] 6.7 Manual validation: verify thread auto-archive behavior

## 7. Cleanup

- [x] 7.1 Deprecate old `sendToDiscord()` function (mark with JSDoc @deprecated)
- [x] 7.2 Update any direct callers to use new function
- [x] 7.3 Update README with new Discord delivery behavior

## 8. Help Needed Section (P1 Enhancement)

- [x] 8.1 Add `ESCALATION_KEYWORDS` constant for keyword-based detection
- [x] 8.2 Add `parseAgeDays()` helper for age string parsing
- [x] 8.3 Add `findHelpNeededBlockers()` function with dual heuristic (age + keywords)
- [x] 8.4 Add Help Needed section to `formatDailyThreadContent()` (after BLOCKERS)
- [x] 8.5 Add Help Needed count field to `formatDailyMainEmbed()` (conditional)
- [x] 8.6 Fix "oldest: today" awkwardness in stats line
- [x] 8.7 Add unit tests for Help Needed functionality

## Dependencies

- Tasks 2.x and 3.x can run in parallel
- Task 5.x depends on 1.x, 2.x, 3.x, 4.x completion
- Task 6.x depends on 5.x completion
- Task 7.x depends on 6.x validation passing
