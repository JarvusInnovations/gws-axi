---
status: done
depends: []
specs:
  - specs/api/conventions.md
issues: [63]
pr: 88
---

# Plan: calendar times in local-offset ISO

## Scope

Render every Calendar event start/end in local-offset ISO (`events`, `search`, `get`, `create`,
`update`), disclose a differing event or calendar zone instead of applying it, and sort
`search` results by instant rather than by string.

**Out of scope:** `drive activity`'s UTC time column (same convention, separate follow-up).

## Implements

- `specs/api/conventions.md` § Displayed times.

## Approach

1. `dateish.ts`: `localEventTime(value)` (dateTime → `toLocalOffsetISO`, date passes through),
   `localZone()` from `Intl`, and `formatEventTime` rendering local plus `(set in <zone>)`
   when the event's zone differs.
2. `events` / `search` schemas use `localEventTime`; `events` adds a note when the response's
   calendar `timeZone` differs from local; `search` sorts by epoch.

## Validation

- [x] Unit: `localEventTime` converts a `-05:00` August Chicago time to `-04:00` under
      `TZ=America/New_York`; all-day passes through; `formatEventTime` suffix only on a differing
      zone.
- [x] Live (read-only, no event created): the issue's own meeting
      (`39rtsin…_20260817T180000Z`) lists at `14:00-04:00` in New York and `13:00-05:00` under
      `TZ=America/Chicago` with the calendar-zone note; `calendar get` shows local time plus
      `(set in America/Los_Angeles)`, the event's declared zone.
- [x] build, lint, format:check, test.

## Risks / unknowns

- Output for any event whose zone differs from the caller's changes shape; consumers parsing the
  full ISO see the same instant.

## Notes

- **Not a DST bug.** Google's offsets were always right for the zone it chose; the zone was
  the calendar's or the event's, passed through verbatim. The issue's own second comment found
  it (`calendar get` showed `America/Chicago`). Devbox's four accounts all have New York
  calendars now, so the original account could not be re-run; the fix was exercised by
  simulating a reader in another zone with `TZ`.
- `calendar get` previously printed this meeting as `11:00-07:00 (America/Los_Angeles)` — the
  same pass-through, in the event's declared zone.
- `search` sorted mixed-offset strings as text across calendars, which misorders events whose
  calendars sit in different zones; it now sorts by instant.
- Tests are zone-agnostic and pass under New York, Chicago, Tokyo, and UTC.

## Follow-ups

- Tracked as: `drive activity`'s time column prints UTC while its range is local — the same
  convention, not yet applied.
