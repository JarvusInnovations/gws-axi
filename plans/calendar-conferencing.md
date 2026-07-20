---
status: in-progress
depends: []
specs:
  - specs/commands/calendar-conferencing.md
issues: [43]
---

# Plan: Calendar — provider-uniform join URLs (conferenceData + scrape fallback)

## Scope

Surface a **provider-uniform join URL** for calendar events, resolving Google
Meet, Calendar-add-on Zoom/Teams/Webex, **and** externally-organized
Teams/Zoom/Webex meetings whose link lives only in the description (issue #43).

**In scope:**

- Shared resolver `src/commands/calendar/conference.ts` — the structured →
  hangoutLink → description/location-scrape chain, provider detection, and
  provider-anchored URL patterns.
- `calendar events` `--fields join_url,conference,conference_source` +
  scrape-disclosure `help[]` line.
- `calendar get` `conference{}` block + `conference_entry_points[]` list +
  `Join <provider>: <url>` help line.
- New focused spec `specs/commands/calendar-conferencing.md` (cross-command
  conferencing surface; not a full calendar backfill).
- Unit tests + README + status-index updates.

**Out of scope:** full calendar-command spec backfill (events/get/create/…);
conferencing on write commands (`create`/`update` still don't set
`conferenceData`); provider coverage beyond Meet/Zoom/Teams/Webex.

## Implements

- `specs/commands/calendar-conferencing.md` — the resolution contract and both
  display surfaces.

## Approach

1. **`conference.ts`** — `extractConference(event)` walks the chain and returns
   `ConferenceInfo{provider,joinUrl,source,entryPoints,fromScrape}` or null;
   `resolveJoinUrl` / `detectProvider` / `scrapeJoinUrl` helpers. Scrape uses an
   ordered list of provider-anchored regexes and returns the leftmost match.
2. **`events.ts`** — three `computed` columns behind `--fields`
   (`join_url`/`conference`/`conference_source`); disclose scraped rows in
   `help[]` when a conference field was requested.
3. **`get.ts`** — render a `conference{}` block + entry-points list when the
   event has conferencing; add a `Join …` help line (scrape-flagged).
4. **Tests** (`conference.test.ts`) — real-shape Meet + Teams-synced fixtures;
   cover each chain step, structured-beats-scraped, phone-only fallthrough,
   angle-bracket termination, `/meet/`-before-`/l/meetup-join/` preference, and
   the null case.
5. **Docs** — README calendar section, `.claude/CLAUDE.md` status line.

## Validation

- [x] `bun run typecheck` passes.
- [x] `bun run lint && format:check && build` pass.
- [x] `bun run test` green (201) incl. new `conference.test.ts` (16).
- [x] Live Meet event → `join_url` = meet link, `conference` = Google Meet,
      `conference_source` = conferenceData; `get` shows the 3 entry points.
      (Delivery Team Meeting, verified.)
- [x] Live externally-organized Teams event (no conferenceData) → `join_url` =
      `teams.microsoft.com/meet/…` scraped from description, `conference_source`
      = description, and the scrape-disclosure help line fires. (Transit Data -
      Weekly Sync, verified.)
- [x] Event with no conferencing → all three columns blank, no conference block.
      (Office, verified.)
- [x] No new OAuth scope added (extraction rides the existing calendar read).

## Risks / unknowns

- **Scrape precision** — provider-anchored regexes match known hosts/join paths
  only, so a stray URL in a description won't be mistaken for a join link; the
  `source`/`fromScrape` disclosure lets consumers gate on structured-only if
  they prefer. New provider URL shapes are an additive follow-up.
- **Redundant hangout_link in `get`** — `hangout_link` stays in the event block
  for back-compat alongside the `conference{}` block; a small duplication traded
  for not breaking existing readers.

## Notes

(Populated at closeout.)

## Follow-ups

(Populated at closeout.)
