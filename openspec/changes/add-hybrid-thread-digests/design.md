# Design: Hybrid Thread Approach for Digests

## Context

Discord webhooks currently send plain text messages with a 2,000 character limit. Weekly reports with full attribution exceed this limit at scale. The PM has validated a hybrid approach: embed-based main message in channel, full details in auto-created thread.

**Stakeholders**: Engineering team (implementation), PM (feature owner), end users (report consumers)

**Constraints**:
- Must use existing webhook infrastructure (no Bot API migration)
- Main message must be scannable in <30 seconds (BLUF research)
- Critical blockers must not require clicking into thread

## Goals / Non-Goals

**Goals**:
- Solve 2,000 char limit for weekly reports at scale
- Surface critical blockers (>5 days, escalations) in main channel message
- Provide full attribution and links in accessible thread
- Color-coded RAG status visible at glance (embed sidebar)

**Non-Goals**:
- Bot API migration (webhooks support threads natively)
- Interactive components (buttons, selects) - keep it simple
- Per-user thread preferences
- Thread reply notifications

## Decisions

### Decision 1: Use Discord Webhooks with `thread_name` (not Bot API)

Discord webhooks support `thread_name` parameter to auto-create threads. This requires no API migration.

**Implementation**:
```typescript
// Step 1: Send main message and create thread
const response = await fetch(`${webhookUrl}?wait=true`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    embeds: [mainEmbed],
    thread_name: "Weekly Details - Dec 16",
  }),
});
const { id: messageId, channel_id } = await response.json();

// Step 2: Send details to the created thread
// The thread_id is the same as the message_id when using thread_name
await fetch(`${webhookUrl}?thread_id=${messageId}`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ content: threadContent }),
});
```

**Alternatives considered**:
- Bot API with `startThread()`: Requires migration, new credentials, more complex
- Multiple messages in channel: Clutters channel, doesn't solve length issue
- External links (Notion, etc.): Adds friction, breaks self-contained reports

### Decision 2: Embed for Main Message (not plain text)

Embeds provide color-coded sidebar for RAG status and structured fields for stats.

**Color mapping**:
- `0x2ECC71` (green): 0 blockers AND 0 stale reviews
- `0xF1C40F` (yellow): 1+ blockers OR 1+ stale reviews  
- `0xE74C3C` (red): Any blocker > 5 days OR explicit escalation

**Embed structure**:
```typescript
{
  color: ragColor,
  title: "Weekly Summary - Week of Dec 16",
  description: "**Status:** At Risk\n**Top Line:** Shipped auth; security review pending 5 days",
  fields: [
    { name: "Shipped", value: "4 PRs", inline: true },
    { name: "Blockers", value: "1 active", inline: true },
    { name: "ESCALATION", value: "Security review - @eve", inline: false }, // Only if red
  ],
  footer: { text: "Full breakdown in thread" }
}
```

**Alternatives considered**:
- Plain text with emoji: No color sidebar, less scannable
- Multiple embeds: Unnecessary complexity for this use case

### Decision 3: Thread Naming Convention

**Pattern**:
- Daily: `{emoji} {date} - Details` (e.g., "Dec 16 - Details")
- Weekly: `{emoji} Week of {start_date} - Details` (e.g., "Week of Dec 16 - Details")

**Rationale**: Date-first for scannability in thread list. "Details" over "Engineering Details" (redundant in eng channel).

### Decision 4: Auto-Archive Duration

**Daily**: 24 hours (1440 minutes)
**Weekly**: 7 days (10080 minutes)

**Rationale**: Daily blockers are stale next day. Weekly reports may be referenced during following week. Archived threads remain searchable.

**Implementation**: Set via `auto_archive_duration` in thread creation (Discord API).

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| `?wait=true` adds latency | Acceptable for scheduled digests; document for future on-demand feature |
| Thread creation failure | Fallback to single long message (current behavior) with truncation warning |
| Embed field limits (25 fields max) | Only use 2-4 fields; stats stay compact |
| Thread archive hides content | Archived threads still searchable; matches natural report cadence |

## Migration Plan

1. **Phase 1**: Add new `sendHybridToDiscord()` function alongside existing `sendToDiscord()`
2. **Phase 2**: Update daily/weekly reporters to use new function
3. **Phase 3**: Deprecate old `sendToDiscord()` after validation
4. **Rollback**: Revert to calling old function (no data migration needed)

## Open Questions

None - all PM decisions received on 2025-12-16.
