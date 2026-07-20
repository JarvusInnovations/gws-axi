# Command: calendar (conferencing / join-URL surface)

## Summary

This spec covers **one cross-command concern**: how `calendar events` and `calendar get` surface a meeting's **join URL** and conferencing metadata. It is scoped to the conferencing surface of those two commands — not a full backfill of every calendar command's behavior.

The core problem it solves: a consumer (e.g. a meeting-alert pipeline) wants a single tappable join link for *any* meeting, regardless of provider (Google Meet, Zoom, Microsoft Teams, Webex). Google's structured `conferenceData` object is the right source **when it exists**, but it is not universally populated — so a genuinely provider-uniform join URL requires a resolution *chain*, and honesty about which link in the chain won.

## Why `conferenceData` alone is insufficient

Google populates `conferenceData` **only when the conference was created through a Google-Calendar-integrated path**:

- Native **Google Meet**, or
- A third-party conferencing **add-on installed in Google Calendar** (e.g. the Zoom-for-GSuite add-on), which writes `conferenceData` at creation time.

A Teams/Zoom/Webex meeting that is **organized externally** (in Outlook/Teams/Zoom) and merely **synced onto the Google calendar via invite** arrives as a plain event:

- `location` carries a human label (`"Microsoft Teams Meeting"`), not a URL.
- The join URL lives in the **`description`** body (provider boilerplate).
- `conferenceData` is **null** and `hangoutLink` is absent.

| Meeting origin | Where the join URL lives |
| --- | --- |
| Native Google Meet | `conferenceData` (video entryPoint) + `hangoutLink` |
| Zoom/Teams/Webex via a Google-Calendar add-on | `conferenceData` (video entryPoint) |
| Teams/Zoom/Webex organized externally, synced in | **`description`** only (`conferenceData` null) |

The third row is common for partner meetings. Surfacing `conferenceData` alone would leave exactly those meetings with a blank join URL.

## Data Requirements

- Calendar `events.list` / `events.get` — `conferenceData`, `hangoutLink`, `location`, and `description` are all in the **default** response; no `fields` mask is set, so nothing extra is requested and **no new OAuth scope** is required. This is a pure output/extraction addition over data already fetched.

## Resolution contract (`src/commands/calendar/conference.ts`)

`extractConference(event)` → `ConferenceInfo{provider,joinUrl,source,entryPoints[],fromScrape}` or `null`. It walks the chain in strict priority order and returns the first hit:

1. **`conferenceData` video entry point** — `conferenceData.entryPoints[]` where `entryPointType === "video"` with a non-empty `uri`. `source: "conferenceData"`. Provider from `conferenceData.conferenceSolution.name`, falling back to host detection. This is the correct source and always wins when present.
2. **`hangoutLink`** — legacy Meet events predating `conferenceData`. `source: "hangoutLink"`, provider `"Google Meet"`.
3. **Scrape `description`, then `location`** — a **provider-anchored** URL match (known conferencing hosts + join paths only, never "any URL"). `source: "description"` or `"location"`, `fromScrape: true`. Provider inferred from the matched host.

- Recognized providers + host anchors: Google Meet (`meet.google.com/<code>`), Zoom (`*.zoom.us/(j|w|my)/…`), Microsoft Teams (`teams.microsoft.com` / `teams.live.com` `/meet/…` or `/l/meetup-join/…`), Webex (`*.webex.com/meet/…` or `*.webex.com/<org>/j.php?…`).
- When several provider URLs appear in the scraped text, the **leftmost** match wins (the top-of-boilerplate `Join: <url>` line beats a deeper `System reference<…>` link).
- Scraped URLs terminate at whitespace/`<`/`>`/`"` so Google's angle-bracket link wrapping does not corrupt the match.
- `entryPoints[]` (video/phone/sip/more from `conferenceData`) always ride along when `conferenceData` is present, even if the video URL was ultimately taken from a different chain step.
- Returns `null` only when the event carries **no** conferencing signal (no `conferenceData`, no `hangoutLink`, no scrapable URL). An event with `conferenceData` but no usable video URL and no scrape hit returns a record with `provider` set and `joinUrl: ""`.

`resolveJoinUrl(event)` is the thin `extractConference(event)?.joinUrl ?? ""` convenience.

## Display Rules

### `calendar events --fields …`

Three opt-in columns (per [minimal-default-schemas](../principles.md#minimal-default-schemas) — conferencing is not shown by default because most events have none):

- **`join_url`** — the resolved best join link, or blank. This is the tappable link a consumer wants; it resolves for Meet, add-on Zoom/Teams/Webex, **and** externally-organized Teams/Zoom/Webex (via scrape).
- **`conference`** — the provider label (`Google Meet` / `Zoom` / `Microsoft Teams` / `Webex`), or blank.
- **`conference_source`** — `conferenceData` | `hangoutLink` | `description` | `location`, or blank. Discloses which chain step won so a `conferenceData`/`hangoutLink` hit can be trusted and a `description`/`location` scrape treated as best-effort.

When **any** returned row's `join_url` came from a scrape (`source` is `description`/`location`) **and** at least one conference field was requested, a `help[]` line discloses the count: `N join_url(s) scraped from event description/location text (no structured conferenceData) — verify before use` ([surface-completeness-limits](../principles.md#surface-completeness-limits)).

### `calendar get`

When the event has conferencing, a **`conference{}` block** renders after the main event block:

- `provider`, `join_url`, `source` (each omitted when empty).
- A **`conference_entry_points[]{type,uri,label}`** list when `conferenceData` supplies structured entry points (video/phone/sip/more) — the full dial-in detail.
- A `help[]` line: `Join <provider>: <url>`, suffixed `(scraped from <source> — verify before use)` when `source` is `description`/`location`.

`hangout_link` stays in the main event block for back-compat; the `conference{}` block is the richer canonical surface and does not remove it.

## Errors

No new error cases. Extraction is best-effort over an already-fetched event; a failure to resolve a link yields a blank `join_url`, never an error.

## Principles

**Inherited:**

- [surface-completeness-limits](../principles.md#surface-completeness-limits) — the `source`/`conference_source` field and the scrape-disclosure `help[]` line make the structured-vs-scraped distinction explicit rather than presenting a best-effort scrape as authoritative.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — `events` conferencing columns are opt-in behind `--fields`; most events have no conferencing, so a mostly-blank default column would waste tokens.
- [ids-are-first-class](../principles.md#ids-are-first-class) — the join URL is the actionable handoff (a consumer attaches a join button); it is surfaced in full, never truncated, and echoed into `help[]`.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — `get` emits a ready-to-use `Join <provider>: <url>` line with the real URL.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — extraction reads `events.list`/`events.get` output only; no new fetch, no new scope, no mutation.
- [single-source-of-truth-helpers](../principles.md#single-source-of-truth-helpers) — both `events` and `get` route through the one `conference.ts` resolver, so the chain and provider patterns are defined once.

**Local:**

- **Structured beats scraped, and say which you gave.** When both a structured source (`conferenceData`/`hangoutLink`) and a description scrape could supply a link, the structured one always wins, and the surface always discloses which was used. A scraped link is genuinely useful (often the *only* source for externally-organized meetings) but is text-extraction, not an API contract — so it is offered, never silently promoted to look authoritative. This is the concrete application of [surface-completeness-limits](../principles.md#surface-completeness-limits) to conferencing; promote it if a second command needs the same structured-vs-scraped disclosure.
