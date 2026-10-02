---
status: done
depends: []
specs:
  - specs/commands/calendar-availability.md
issues: [62]
pr: 95
---

# Plan: calendar free/busy

## Scope

#62: `--free` / `--busy` on `calendar create` and `update`; `availability` on `get`, on
create/update output, and as an `events --fields` column; unknown flags rejected on create and
update.

## Implements

- `specs/commands/calendar-availability.md`

## Approach

`src/commands/calendar/availability.ts` (mapping, flag exclusivity, unknown-flag rejection);
the create/update parsers' default cases reject `--` flags against their own case lists.

## Validation

- [x] Unit: mapping, parsing, exclusivity, unknown flags (incl. the issue's `--transparency`), a
      second event id.
- [x] Live: created a free event on chris@jarv.us (2026-12-31, no attendees), read it free via
      `get` and `events --fields availability`, flipped it busy (`fields_changed: availability`),
      got `VALIDATION_ERROR` for `--transparency`, deleted it.
- [x] build, lint, test.

## Risks / unknowns

- Rejecting unknown flags on create/update could break a caller that passed a stray flag; that
  caller was already getting a silent no-op.

## Notes

- `calendar events --fields` still skips unknown field names silently — a deliberate leniency
  noted in its code — and `delete` / `respond` keep their lenient parsers. Left as-is here.

## Follow-ups

- Tracked as: apply fail-loud flag parsing across the remaining older parsers (calendar
  delete/respond, events `--fields`, docs read, drive upload).
