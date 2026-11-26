# Calendar events: expose event type

## Problem Statement

`gws-axi calendar events` lists native out-of-office, focus-time, and working-location events without identifying their types. A title such as “Out of office” can also belong to an ordinary event. The `availability` column reports free or busy, not event type. A caller that needs to tell these events apart must query Google Calendar separately.

## Solution

`calendar events --fields eventType` adds an `eventType` column to the TOON event list. Each row shows the exact value returned by Google Calendar, or a blank cell when Google does not supply it. Callers can request the column alongside `status` and other extra columns. Listings that do not request it stay unchanged.

## User Stories

1. As a calendar automation author, I want to identify native `outOfOffice` events in a time window, so that I can detect time-off blocks without a second calendar query.
2. As a calendar automation author, I want `default` events to remain distinct from `outOfOffice` events, so that a regular event titled “Out of office” does not count as time off.
3. As a calendar automation author, I want `focusTime` to be distinguishable from `outOfOffice`, so that I do not treat a focus block as leave.
4. As a calendar automation author, I want `workingLocation` to be distinguishable from `outOfOffice`, so that working remotely does not count as being away.
5. As an agent building a calendar digest, I want to recognize `birthday` and `fromGmail` events, so that I can decide which kinds of events belong in the digest.
6. As a script author, I want Google’s exact values and casing, so that I can compare them with the Calendar API documentation without a translation table.
7. As a script author, I want new type values to pass through unchanged, so that a value Google adds is not silently dropped or mislabeled by the CLI.
8. As a script author, I want a blank cell when Google omits the type, so that I can distinguish missing data from an explicit `default` value.
9. As an agent evaluating time off, I want to request `status` and `eventType` together, so that I can distinguish event type from cancellation status in the same listing.
10. As an agent evaluating time off, I want the same start and end columns alongside `eventType`, so that I can use the returned event interval rather than infer coverage from its type.
11. As an existing CLI consumer, I want `eventType` to be opt-in, so that my default output and parsing logic do not change.
12. As a user reading command help, I want to see `eventType` among the valid extra fields, so that I can discover the feature without looking at the source.
13. As a CLI user, I want misspelled field names to keep producing the existing validation error, so that I do not mistake a failed field request for a successful read.

## Implementation Decisions

- The public interface is the existing `calendar events` command and its `--fields` option. The accepted field name and TOON column name are both `eventType`.
- The command renders Google Calendar’s `events.list` value directly through the existing extra-field renderer. It does not infer type from the title, `availability`, or `status`; it does not normalize or restrict Google’s values to a local list.
- An omitted or null value renders as a blank cell, just like other absent extra fields. An explicit `default` remains `default`.
- `eventType` follows the existing field selection, ordering, and validation rules. It does not change which rows are returned, the default columns, or the meaning of other columns.
- The list request, time window, recurrence expansion, result limits, and account selection stay unchanged. The command already receives event records containing this property when Google supplies it. No extra request, OAuth scope, or dependency is needed.
- Command help lists the field. The README shows how to request it alongside `status`.

## Testing Decisions

- Use one automated seam: invoke the calendar list command handler with CLI arguments and fixture events provided through the existing Google client interface. Assert on rendered TOON columns and values, not field registration or renderer internals. The Sheets query handler tests establish this pattern. No new production seam is needed.
- Supply events with an explicit `outOfOffice` type, a `default` event whose title says “Out of office,” another native type, an unfamiliar type, and a missing type. Verify the exact values, including the blank cell, when `eventType` is requested alongside `status`.
- With the same event data, call the handler without `--fields` and verify that the default column set is unchanged. Unknown-field validation follows the existing `--fields` contract.
- Smoke-test the fork’s CLI: check command help and run a read-only calendar list with `status,eventType` against the intended account. Do not install the fork globally or include private event details in the PR.

## Out of Scope

- Changes to `calendar get`, calendar write commands, or default list output.
- Server-side filtering by type or changes to pagination and time-range semantics.
- Computing out-of-office coverage or changing downstream workflows.
- Replacing the installed CLI or publishing an npm release from the fork.

## Further Notes

- [Google Calendar’s Event resource](https://developers.google.com/workspace/calendar/api/v3/reference/events#resource-representations) defines `eventType`. The documented values are `birthday`, `default`, `focusTime`, `fromGmail`, `outOfOffice`, and `workingLocation`.
