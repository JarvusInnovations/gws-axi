---
status: done
depends: []
specs:
  - specs/commands/calendar-conferencing.md
issues: [43]
pr: 44
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

- **The issue's premise was half-wrong, and live data caught it.** #43 said the
  join URL "lives in the structured conferenceData object" for Teams/Zoom/Webex.
  Testing against a real Teams meeting (Transit Data - Weekly Sync) showed
  `conferenceData: null` — Google only populates it for Calendar-integrated
  conferences (native Meet or a Calendar add-on). Externally-organized meetings
  synced in via invite carry the URL only in the description. So the
  "fragile fallback" the issue dismissed is the *only* source for that whole
  class of meeting; the scrape isn't a nicety, it's load-bearing.
- **Scrape is provider-anchored, not "any URL".** The perceived fragility comes
  from grabbing any URL; matching known conferencing hosts + join paths
  (`meet.google.com`, `*.zoom.us/(j|w|my)`, `teams.(microsoft|live).com`,
  `*.webex.com`) is reliable. `source`/`fromScrape` still disclose it so a
  consumer can gate on structured-only if it prefers.
- **No new scope, no new fetch.** `conferenceData`/`description`/`location` are
  already in the default `events.list`/`get` response.
- **Structured-beats-scraped disclosure** is captured as a local principle in
  `specs/commands/calendar-conferencing.md`; promote to `principles.md` if a
  second command needs the same structured-vs-scraped honesty.

## Follow-ups

- **Conferencing on write commands** — `calendar create`/`update` don't set
  `conferenceData` (would need `conferenceDataVersion=1` + a
  `createRequest`). Separate effort if we want to *create* Meet links.
- **Provider coverage** — Meet/Zoom/Teams/Webex today; new provider URL shapes
  (GoTo, Around, vanity Zoom domains) are additive to `PROVIDER_PATTERNS`.
- **Full calendar spec backfill** — this speccs only the conferencing surface of
  `events`/`get`; the rest of the calendar command behavior remains unspecced.
