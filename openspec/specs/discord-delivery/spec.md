# discord-delivery Specification

## Purpose
TBD - created by archiving change add-hybrid-thread-digests. Update Purpose after archive.
## Requirements
### Requirement: Hybrid Thread Delivery

The system SHALL deliver reports using a two-phase hybrid approach: an embed-based main message in the channel and full details in an auto-created thread.

#### Scenario: Weekly report delivery with blockers

- **GIVEN** a weekly report with 4 shipped PRs and 1 active blocker (5+ days old)
- **WHEN** the report is sent to Discord
- **THEN** a color-coded embed appears in the channel with RAG status sidebar
- **AND** the embed description stays under 400 characters
- **AND** a thread is auto-created with naming pattern "Week of {date} - Details"
- **AND** the thread contains the full blocker list, shipped PRs with attribution, and help needed section

#### Scenario: Daily report delivery

- **GIVEN** a daily report with 2 in-progress PRs and 3 blockers
- **WHEN** the report is sent to Discord
- **THEN** a color-coded embed appears in the channel
- **AND** the top blocker surfaces in the main embed (not hidden in thread)
- **AND** a thread is auto-created with naming pattern "{date} - Details"
- **AND** the thread contains full blocker details, awaiting review section, and in-progress work

#### Scenario: Report with no blockers

- **GIVEN** a report with 0 blockers and 0 stale reviews
- **WHEN** the report is sent to Discord
- **THEN** the embed sidebar color is green (0x2ECC71)
- **AND** no ESCALATION field appears in the embed

### Requirement: RAG Status Color Coding

The system SHALL display a color-coded sidebar on the main embed based on blocker severity.

#### Scenario: Green status

- **GIVEN** a report with 0 active blockers AND 0 stale reviews
- **WHEN** the embed is rendered
- **THEN** the sidebar color is green (0x2ECC71)

#### Scenario: Yellow status

- **GIVEN** a report with 1+ blockers OR 1+ stale reviews (none > 5 days)
- **WHEN** the embed is rendered
- **THEN** the sidebar color is yellow (0xF1C40F)

#### Scenario: Red status

- **GIVEN** a report with any blocker > 5 days old OR an explicit escalation tag
- **WHEN** the embed is rendered
- **THEN** the sidebar color is red (0xE74C3C)
- **AND** an ESCALATION field appears in the embed with the top blocker summary

### Requirement: Escalation Surfacing

The system SHALL surface critical blockers in the main channel message without requiring thread access.

#### Scenario: Blocker exceeds 5 day threshold

- **GIVEN** a blocker that has been active for 6 days
- **WHEN** the report embed is generated
- **THEN** the blocker appears as an ESCALATION field in the main embed
- **AND** the embed shows the blocker description and owner mention

#### Scenario: Multiple escalations

- **GIVEN** 3 blockers that exceed the 5 day threshold
- **WHEN** the report embed is generated
- **THEN** the top blocker (oldest) appears in the ESCALATION field
- **AND** the embed indicates remaining escalation count (e.g., "+2 more in thread")

### Requirement: Thread Auto-Archive

The system SHALL configure auto-archive duration based on report type to reduce channel clutter.

#### Scenario: Daily thread archive

- **GIVEN** a daily report thread is created
- **WHEN** the thread creation request is sent
- **THEN** auto_archive_duration is set to 1440 minutes (24 hours)

#### Scenario: Weekly thread archive

- **GIVEN** a weekly report thread is created
- **WHEN** the thread creation request is sent
- **THEN** auto_archive_duration is set to 10080 minutes (7 days)

### Requirement: Thread Naming Convention

The system SHALL use consistent, scannable thread names with date-first ordering.

#### Scenario: Daily thread naming

- **GIVEN** a daily report for December 16, 2025
- **WHEN** the thread is created
- **THEN** the thread name is "Dec 16 - Details"

#### Scenario: Weekly thread naming

- **GIVEN** a weekly report for the week starting December 16, 2025
- **WHEN** the thread is created
- **THEN** the thread name is "Week of Dec 16 - Details"

### Requirement: Graceful Fallback

The system SHALL fall back to single-message delivery if thread creation fails.

#### Scenario: Thread creation failure

- **GIVEN** the Discord API returns an error when creating a thread
- **WHEN** the hybrid send is attempted
- **THEN** the system logs a warning
- **AND** sends the full report as a single message (current behavior)
- **AND** truncates if necessary with a "Report truncated" indicator

#### Scenario: Wait timeout

- **GIVEN** the `?wait=true` request times out
- **WHEN** the system cannot retrieve the message ID for thread posting
- **THEN** the main embed is still delivered
- **AND** thread details are skipped with a logged warning

