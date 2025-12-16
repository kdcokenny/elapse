# Change: Hybrid Thread Approach for Digests

## Why

Discord's 2,000-character message limit blocks weekly reports at scale. When teams ship 10+ PRs with 5+ blockers, the full report with attribution and links exceeds this limit. The PM-validated BLUF (Bottom Line Up Front) research shows that critical blockers must remain visible in the main channel message while full details can live in a thread.

## What Changes

- **Main message format**: Switch from plain text to Discord embeds with color-coded RAG status sidebar
- **Thread creation**: Auto-create threads for full report details using webhook `thread_name` parameter
- **Two-phase delivery**: Main embed in channel (< 400 chars), full breakdown posted to auto-created thread
- **Auto-archive**: Daily threads archive after 24 hours, weekly threads after 7 days
- **Escalation surfacing**: Any blocker > 5 days or tagged escalation surfaces in main message (not just thread)

## Impact

- **Affected specs**: New `discord-delivery` capability (no existing specs to modify)
- **Affected code**:
  - `src/discord.ts` - Add embed support, thread creation, two-phase send
  - `src/core/formatting.ts` - Split formatting into main message vs thread content
  - `src/daily-reporter.ts` - Use new hybrid send function
  - `src/weekly-reporter.ts` - Use new hybrid send function
- **Breaking changes**: None (webhook URL config unchanged, behavior additive)
- **New env vars**: None required (uses existing webhook URLs)

## Success Criteria

1. Main embed stays under 400 characters (description + fields)
2. Any red status surfaces in main message without clicking thread
3. Thread contains full attribution and links for drill-down
4. Weekly reports with 10+ PRs and 5+ blockers render without truncation
5. Color-coded sidebar visible in Discord mobile and desktop

## PM Decision Record

- **Date**: 2025-12-16
- **Priority**: P0
- **Rationale**: Solves hard character limit, aligns with BLUF research, zero migration risk
