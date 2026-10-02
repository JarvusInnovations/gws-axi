# Behavior: calendar event availability (free / busy)

## Summary

An event's free/busy setting — the Calendar API's `transparency`, the UI's "Show as" — from
issue #62. A multi-hour window someone *might* attend belongs on the calendar as **free** so it
doesn't block scheduling. Writes set it; reads show it.

Named as the UI names it (`free` / `busy`), not as the API does (`transparent` / `opaque`).

## Writes

- `calendar create` and `calendar update` take `--free` or `--busy`. Together they are a
  `VALIDATION_ERROR`. `create` without either leaves Google's default, busy.
- `update --free` / `--busy` counts as a change on its own, and `fields_changed` reports it as
  `availability`.
- Both commands print `availability` in their `event{}` block.

## Reads

- `calendar get` always shows `availability: free | busy`.
- `calendar events --fields availability` adds the column.
- Google omits `transparency` for the default; absent reads as `busy`.

## Unknown flags fail

`calendar create` and `calendar update` reject a flag they don't know with `VALIDATION_ERROR`,
listing their valid flags, and `update` rejects a second event id. `--transparency` gets a
pointed hint at `--free` / `--busy`.

> **Why:** before this, `update --transparency transparent` was dropped silently and the command
> reported success with the flag missing from `fields_changed` — a missing feature turned into
> a false success ([AXI: fail loud on unrecognized input](../principles.md#structured-errors-to-stdout)).

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `events.insert` / `events.patch` with `transparency: "transparent"` / `"opaque"` set free / busy | **Observed 2026-10-02** |
| A busy event reads back with `transparency` absent | Documented default; observed |

## Principles

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account).
- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — unknown flags are errors, not no-ops.
