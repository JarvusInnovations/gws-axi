---
status: done
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
