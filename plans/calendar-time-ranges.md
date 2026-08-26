---
status: done
depends: []
specs:
  - specs/api/conventions.md
issues: []
pr: 65
---

# Plan: Deterministic time ranges — day boundaries, relative tokens, window shortcuts

## Scope

Make time-range flags say what a caller means. Today `--from 2026-08-26 --to 2026-08-26`
resolves to a **zero-width window** (both edges become local midnight of the 26th) and
renders as `count: 0` / `events: no events found in the given time range` — a query that
*cannot* match anything, reported as an empty calendar. This plan fixes the boundary
semantics, makes the impossible window an error, and gives agents deterministic ways to
ask the two most common questions: today, and this week.

**In scope:**

- **Per-edge precision expansion** — a date-only value on a `--to`/`--until` edge resolves
  to the *next* local midnight, so `--from D --to D` is the whole of day D.
- **Relative tokens** on every range flag — `now`, `today`, `tomorrow`, `yesterday`,
  `±Nd`, `±Nw` (day precision), `±Nh` (instant precision).
- **Window shortcuts** `--today` and `--this-week` on `calendar events`, `calendar search`,
  `calendar freebusy`, with the week's first day taken from the account's Google Calendar
  `weekStart` setting (cached per account, Monday fallback).
- **Empty-window validation** — `from >= to` is a `VALIDATION_ERROR`, never an empty list.
- **Local-offset `range:` echo** everywhere a range is applied, including a new echo on
  `drive activity` (which currently applies `--since/--until` without reporting the window).
- **Help discoverability** — shortcuts visible in the flags block, the examples block, and
  `calendar --help`, alongside the exact-range example rather than buried below it.
- Range flags on `drive activity` (`--since`/`--until`) get precision expansion, tokens,
  and validation — but **not** the shortcut flags.

**Out of scope:**

- Weekday-name tokens (`monday`, `friday`) — unresolvable without guessing next-vs-previous;
  see [Risks](#risks--unknowns).
- `--tomorrow` / `--next-week` / `--this-month` shortcut flags — reachable via tokens
  (`--from tomorrow --to tomorrow`); revisit only if usage shows they're common.
- Issue #63 (timed starts print the zone's standard offset year-round, DST-unaware) — a
  *rendering* bug in the event columns, distinct from boundary arithmetic. This plan's
  arithmetic must be DST-correct, which is a precondition for #63, not a fix for it.
- `gmail search`'s `after:`/`before:` operators — Gmail's own query grammar, not our flags.

## Implements

- `specs/api/conventions.md` § **Time ranges** — the whole section: half-open ranges,
  the per-edge precision table, the relative-token table, local-calendar arithmetic,
  `--today` / `--this-week` semantics + conflict rule, empty-window `VALIDATION_ERROR`,
  and the local-offset `range:` echo.

## Approach

### 1. `src/commands/calendar/dateish.ts` — the resolution layer

`parseDateishFlag(value)` stays **exactly as-is** and keeps its instant semantics. It feeds
`calendar create --start/--end` and `calendar update --start/--end`, where silently rounding
a date-only value up to next midnight would be wrong (`--start 2026-08-26` means an event at
midnight, not one at the end of the day). Range behavior is layered on top, not folded in:

```ts
export type RangeEdge = "from" | "to";

/** Resolve one range-flag value to an ISO instant, honoring per-edge day expansion. */
export function parseRangeFlag(value: string, edge: RangeEdge, now?: Date): string;

/** Resolve --today / --this-week / --from / --to into a validated {from,to} pair. */
export function resolveWindow(
  input: { today?: boolean; thisWeek?: boolean; from?: string; to?: string },
  defaults: { from: string; to: string },
  flagNames?: { from: string; to: string },  // "--since"/"--until" for drive activity
): { from: string; to: string };
```

`parseRangeFlag` resolves in three steps:

1. **Token?** → `now` (instant), `today`/`tomorrow`/`yesterday` (day), `±Nd`/`±Nw` (day),
   `±Nh` (instant). Day tokens produce a `{y,m,d}` triple, not a timestamp.
2. **Date-only literal?** (`^\d{4}-\d{2}-\d{2}$`) → same `{y,m,d}` triple.
3. **Otherwise** → delegate to `parseDateishFlag` (instant, unchanged error messages).

Day-precision results then take the edge into account: `from` → `new Date(y, m-1, d)`,
`to` → `new Date(y, m-1, d + 1)`. Using the local `Date` constructor with an overflowing
day component is what makes the arithmetic DST-correct and month/year-rollover-correct in
one stroke — never `+ n * 86_400_000`.

Week helpers for `--this-week`: `startOfWeek(now, weekStartDay)` = local midnight of the most
recent occurrence of `weekStartDay` (0=Sun…6=Sat) on or before today —
`back = (getDay() - weekStartDay + 7) % 7` — and end = that day `+ 7`. Pure and injectable; the
setting lookup lives in step 1b, never inside the arithmetic.

`resolveWindow` owns the conflict and validation rules so no call site re-implements them:

- `--today` **and** `--this-week` → `VALIDATION_ERROR`.
- a shortcut **and** `--from`/`--to` → `VALIDATION_ERROR` naming both.
- resolved `from >= to` → `VALIDATION_ERROR` echoing both resolved boundaries in
  local-offset form plus the flags that produced them.

Error suggestions must be runnable, not descriptive — an empty window suggests the
shortcut that probably matches the intent (`Use --today for a single day`).

### 1b. `weekStart` — read once, cache per account

`--this-week` needs the account's week-start day. Verified live against `chris@jarv.us`: the
existing `calendar` scope already authorizes `calendar.settings.get({setting:"weekStart"})`
(returns `value: "1"`), so **no scope change and no re-auth** — this is a plain read.

- New `src/commands/calendar/week-start.ts`:
  `resolveWeekStart(account): Promise<{ day: 0|1|6; label: string; source: "account"|"cache"|"fallback" }>`.
- Cache file `~/.config/gws-axi/accounts/<email>/settings.json` — `{ week_start, fetched }`.
  A **separate file from `profile.json`**, which the auth flow rewrites wholesale from the
  id_token; a cached API preference stored there would be clobbered on every re-login. Path
  helper alongside `profilePathForAccount` in `src/config.ts`.
- TTL 30 days; missing/expired/corrupt cache → fetch → write. Any failure (403, offline,
  unparseable value) → `{ day: 1, label: "monday", source: "fallback" }`, never a thrown error.
- Only called when a week shortcut is actually used, so `--today` and explicit ranges stay
  single-round-trip.
- Commands using it add `week_start: <label> (<source>)` to the summary block, next to `range:`.

### 2. Call sites

| File | Change |
| --- | --- |
| `calendar/events.ts` | `--today`/`--this-week` in `ParsedFlags`; `parseRangeFlag` for `--from`/`--to`; `resolveWindow` after the parse loop; `range:` via `toLocalOffsetISO`; help block (below) |
| `calendar/search.ts` | same, keeping the 30-days-ago → 1-year-out defaults |
| `calendar/freebusy.ts` | same; its existing hand-rolled start/end-of-today defaults become `resolveWindow`'s defaults, and its `range:` already uses `toLocalOffsetISO` |
| `drive/activity.ts` | `parseRangeFlag(next, "from"\|"to")` for `--since`/`--until`; `resolveWindow` with `flagNames: {from:"--since", to:"--until"}` and **undefined** defaults (both edges stay optional — the filter omits absent clauses); add a `range:` echo to the output header when either edge is set |

Note `drive activity` already builds `time >= from` / `time < to`, so it is half-open and
needs no filter change — only boundary resolution.

### 3. Help surfaces

The user-facing ask: the shortcuts must be visible *early*, on the same screen as the
exact-range example — not documented below the fold.

- `EVENTS_HELP` (and search/freebusy equivalents): `--today` and `--this-week` listed
  immediately after `--from`/`--to` in the flags block (bump the `flags[N]` counts), with
  `--from <when>` / `--to <when>` re-described to mention tokens.
- Examples block gains `--today` and `--this-week` lines directly **above** the existing
  `--from 2026-04-20T00:00 --to 2026-04-21T00:00` example, so the sugar and the precise
  form are read together.
- The `time formats:` block becomes `time formats / ranges:` and states the day-boundary
  rule in one line (`Date-only: 2026-04-20 — --from = 00:00, --to = end of that day`)
  plus the token list.
- `CALENDAR_HELP` (`src/commands/calendar.ts`): add `gws-axi calendar events --today` and
  `--this-week` to its examples block.
- Empty-result `help[]` in `events`/`search`: the current "Broaden the time range with
  --from / --to (current: …)" line gains a concrete shortcut suggestion.

### 4. Tests — `src/commands/calendar/dateish.test.ts` (new)

All helpers take an injectable `now`, so every case is deterministic without faking timers.

- Per-edge expansion: date-only on `from` vs `to`; instants untouched on both edges.
- Monotonicity guard: `--from D --to D` ⊂ `--from D --to D+1`, and the two windows differ.
- Tokens: each of `now`/`today`/`tomorrow`/`yesterday`/`±Nd`/`±Nw`/`±Nh`; unknown token
  falls through to the existing `parseDateishFlag` error, message unchanged.
- Local-calendar arithmetic: `+1d` across a month boundary, a year boundary, and across a
  US DST transition still lands on local midnight (not 23:00/01:00).
- `startOfWeek`: each `weekStart` value (0/1/6) evaluated from a Monday, a Sunday, and a
  Wednesday; `--this-week` spans exactly 7 local days in every case, including across a DST
  transition.
- `weekStart` cache: cold read fetches and writes, a warm read inside TTL does not refetch, an
  expired entry refetches, and an unparseable value / thrown fetch both fall back to Monday
  with `source: "fallback"`.
- `resolveWindow`: shortcut+explicit conflict, double shortcut, `from == to`, `from > to`,
  and the happy path with defaults.

## Validation

- [x] `bun run build` (tsc) passes.
- [x] `bun run test` green, including the new `dateish.test.ts`.
- [x] `calendar events --from 2026-08-26 --to 2026-08-26` returns that day's events (the
      originating bug), and `range:` echoes `…T00:00:00-04:00 → 2026-08-27T00:00:00-04:00`.
- [x] `calendar events --today` and `--this-week` return the expected windows; `--this-week`
      spans the account's week-start day 00:00 → the same weekday 00:00 seven days later when
      run mid-week (Monday for `chris@jarv.us`, whose `weekStart` is `1`).
- [x] `--this-week` reports `week_start: monday (account)` on a cold run and `(cache)` on the
      next; the cache lands in `accounts/<email>/settings.json` and survives an `auth login`
      (i.e. is not stored in `profile.json`).
- [x] With the setting lookup forced to fail, `--this-week` still returns a window and reports
      `week_start: monday (fallback)` — no error.
- [x] `calendar events --from 2026-08-26T10:00 --to 2026-08-26T09:00` → `VALIDATION_ERROR`
      naming both boundaries, **not** `count: 0`.
- [x] `calendar events --today --from 2026-08-26` → `VALIDATION_ERROR`; `--today --this-week`
      → `VALIDATION_ERROR`.
- [x] `calendar create --start 2026-08-26 --end 2026-08-26T11:00` is unchanged by this work
      (instant semantics preserved for non-range flags).
- [x] `calendar search --query <x> --this-week` and `calendar freebusy --today` honor the
      same windows; freebusy's default (today) still works with no flags.
- [ ] `drive activity <id> --since today` resolves to local midnight and the output echoes
      the resolved `range:`. *(Boundary resolution verified; the `range:` echo could not be
      exercised — see Notes.)*
- [x] `calendar events --help`, `calendar search --help`, `calendar freebusy --help`, and
      `calendar --help` all show the shortcuts in the flags/examples blocks with correct
      `flags[N]` counts.
- [x] Every `range:` echo renders local-offset ISO, no `Z`/`.000Z` form. *(Verified live on
      events / search / freebusy; `drive activity`'s echo by inspection only — see Notes.)*

## Risks / unknowns

- **The `--to D` vs `--to DT00:00` discontinuity is real.** Two spellings that look
  equivalent resolve to boundaries 24h apart. This is inherent to letting a date mean a day;
  the mitigation is disclosure (help text + spec table + the `range:` echo), not avoidance.
  The alternative — expanding only when `from == to` — is worse and is rejected in the spec.
- **Weekday tokens deliberately omitted.** `monday` has no non-guessing resolution. If they
  land later they need explicit `next-monday` / `last-monday` spellings.
- **`weekStart` is a cached remote preference.** Verified live that the existing `calendar`
  scope covers `settings.get` (no re-auth), but the value can go stale within the TTL and the
  fetch can fail. Mitigated by: a Monday fallback that never fails the query, the `week_start:`
  field disclosing both value and source on every week-shortcut call, and the `range:` echo
  showing the concrete window regardless.
- **`drive activity` edges are optional**, unlike the calendar commands where both always
  resolve to a default. `resolveWindow` must tolerate `undefined` on either side and only
  run the `from >= to` check when both are present.
- **Flag-count drift in help blocks** — `flags[N]` headers are hand-maintained; adding two
  flags to three help strings is three chances to leave a stale count.

## Notes

- **The originating bug, before and after.** `--from 2026-08-26 --to 2026-08-26` went from
  `count: 0` / `events: no events found in the given time range` to `count: 7` with
  `range: 2026-08-26T00:00:00-04:00 → 2026-08-27T00:00:00-04:00`. The UTC `range:` echo was
  part of what made the zero-width window invisible: `…T04:00:00.000Z → …T04:00:00.000Z`
  reads like a real range unless you compare the two halves character by character.
- **`weekStart` reversed an earlier decision, and the reversal was right.** The spec first
  fixed the week to Monday on determinism grounds. The counter-argument — someone asking
  their own calendar "what's this week" means the week their calendar draws — wins, because
  the determinism concern was really a *disclosure* concern, and the `range:` echo plus
  `week_start: <day> (<source>)` answers it without a constant. Verified live that the
  existing `calendar` scope already authorizes `settings.get`, so this cost no re-auth.
- **`settings.json` is a deliberate sibling of `profile.json`, not a section inside it.**
  `src/auth/loopback.ts` rewrites `profile.json` wholesale from the id_token on every
  login; a cached API preference stored there would vanish on re-auth. Confirmed by
  inspection that nothing outside `week-start.ts` touches `settings.json`.
- **`Number("") === 0` bit us.** An empty `weekStart` value parsed to a *valid* day (Sunday)
  rather than failing, so the fallback never engaged. Caught by the new tests, fixed in
  d5bd070. Worth remembering wherever a numeric enum's zero value is meaningful.
- **freebusy's default day shifted by a millisecond-ish.** It used to end at
  `23:59:59.999`; it now ends at the next local midnight, matching `--today` and the
  half-open contract. Behaviorally equivalent apart from an event starting exactly at
  midnight, which now correctly belongs to the following day.
- **`drive activity` could not be exercised end to end** — `driveactivity.googleapis.com`
  is not enabled on this account's project (`API_NOT_ENABLED`). Flag resolution was verified
  through the error path (`--since D --until D` passes validation and reaches the API;
  inverted bounds fail first with `--since`/`--until` named correctly), but the `range:`
  echo in a successful response is unverified.
- **Tests inject `now` everywhere** rather than faking timers, so the DST cases are readable
  and the suite doesn't depend on the wall clock. The DST assertions do assume the repo's
  `America/New_York` zone; everything else is zone-agnostic.


## Follow-ups

- Issue — verify `drive activity`'s `range:` echo once `driveactivity.googleapis.com` is
  enabled on the project. Purely a display path; the boundary logic it reports is covered by
  `dateish.test.ts`.
- Tracked as: weekday-name tokens (`next-monday` / `last-monday` spellings) if range queries
  start wanting them — deliberately omitted here because bare `monday` can't be resolved
  without guessing.
- Tracked as: `--tomorrow` / `--next-week` / `--this-month` shortcuts. Reachable today via
  tokens (`--from tomorrow --to tomorrow`); add only if usage shows they're common enough to
  earn flag surface.
- Issue [#63](https://github.com/JarvusInnovations/gws-axi/issues/63) — timed starts print
  the zone's standard offset year-round. Untouched here, but this plan's local-calendar
  arithmetic is the precondition for fixing it, and `settings.list` also exposes the
  account's `timezone`, which that fix will likely want.
