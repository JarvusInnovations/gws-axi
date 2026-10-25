---
status: done
pr: 145
depends: []
specs:
  - specs/commands/sheets-query.md
  - specs/commands/sheets-read.md
---

# Plan: Header legend for sheets query and sheets read

## Scope

The map between a tab's header names and its A1 letters, in the responses that need it.
`sheets query` addresses columns by letter while agents know them by name; `sheets read`'s
header promotion drops the letters. Both gain a `headers[N]{letter,header}` block; a
`QUERY_ERROR` carries a compact legend line. No name-to-letter translation of the query —
the query stays Google's to parse.

**Out of scope:** backticked-name translation in queries (revisit only if agents still
mis-address columns with the legend in front of them).

## Implements

- `specs/commands/sheets-query.md` — § Header legend, the help bullet, the example.
- `specs/commands/sheets-read.md` — § Header legend.

## Approach

1. `shared.ts`: `LegendEntry`, `LEGEND_SCHEMA`, `renderLegend(entries, cap)`, and
   `legendLine(entries)` for the error suggestion (first 30, then `… N more`).
2. `query.ts`: fetch row 1's display text (`fetchGrid`, `'<tab>'!1:1`) in parallel with the
   gviz call, best-effort; skip under `--headers 0`; render after the rows with
   `headers_total` past 100; drop the letters help line when present, keep it with
   `headers: unavailable (…)` when the read failed; pass the legend into `queryError`.
3. `read.ts`: `buildGrid` returns `legend` when it promotes a header row (letters from the
   origin, names as the grid uses them, only columns whose header cell has text); render it
   after the grid.
4. Tests: query handler (legend rendered, letters line dropped, `--headers 0` omits it, failed
   legend read keeps the query, legend on `QUERY_ERROR`); `buildGrid` legend with an origin
   at C and an empty header cell. README one line, CLAUDE.md bullets.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit/handler tests above.
- [x] Live: `sheets query` on a headed scratch tab shows the legend; a wrong-letter query's
      `QUERY_ERROR` carries the legend line; `sheets read --range C1:E9 --header-row` lists
      C, D, E.

## Risks / unknowns

- None of substance; one extra parallel read per query.

## Notes

- Small enough to build inline rather than through a builder subagent.
- The legend read reuses `fetchGrid` (row 1, `formattedValue` only) and runs beside the gviz call, so it adds no round trip. Existing handler tests needed no change: their mock returns no row-1 data, which is the "no legend, keep the letters line" path.
- Live on a scratch spreadsheet in the owner's safe-to-delete folder: query legend, the legend line on a `select ZZ` `QUERY_ERROR`, and a `C1:E4` promoted read listing C, D, E.

## Follow-ups

- Tracked as: backticked-name translation in queries — only if agents still mis-address columns with the legend in front of them.
