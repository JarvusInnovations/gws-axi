---
status: in-progress
depends: []
specs:
  - specs/commands/calendar-event-type.md
---

# Plan: Calendar event types

## Scope

Expose the type returned by Google on `calendar events` when requested. Leave default output, event selection, and other Calendar commands unchanged.

## Implements

- [Calendar event type](../specs/commands/calendar-event-type.md): opt-in `eventType` column, exact upstream values, and blank cells for missing types.

## Approach

Use the existing extra-field selection and scalar renderer. Document the field in command help and the README.

Use the Sheets query handler test pattern: call the list handler with CLI arguments and supply fixture events through the existing Google client interface. Assert on rendered TOON, not field registration or renderer internals. Check `status,eventType` with native types, a regular event titled “Out of office,” an unfamiliar type, and missing and null types. Reuse the fixtures to check default columns, and check that a misspelled field fails validation.

Smoke-test the fork without installing it globally: check command help and run a read-only `calendar events --fields status,eventType` against the intended account. Keep private event details out of the PR.

## Validation

- [x] Handler tests cover exact values, unknown types, missing and null values, default columns, and unknown-field validation.
- [x] Targeted tests and `bun run typecheck` pass.
- [x] Local CLI help lists the field, and a read-only Calendar request returns `status` and `eventType` together.

## Risks / unknowns

A missing type is not evidence that an event is a `default` event.

## Notes

The live smoke test checked the output columns without recording event details.

## Follow-ups

None.
