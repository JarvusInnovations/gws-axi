---
status: done
depends: [docs-table-cols]
specs:
  - specs/commands/docs-write.md
pr: 118
---

# Plan: Make the table extensions discoverable from the tool

## Scope

The `<!-- cols: … -->` hint and the `<br>` / `- item` cell forms (#106, #107) were only
discoverable by reading a Doc that already used them. Document the dialect in
`docs write --help` and disclose the hint contextually in the write response when a table
was written with default widths.

## Implements

- `specs/commands/docs-write.md` § help[] — the new contextual line.

## Approach

1. `WRITE_HELP` gains a `markdown:` block listing the dialect and the two table extensions;
   `CREATE_HELP` / `APPEND_HELP` point at it.
2. `tableHelp(tables)` — pure, exported — returns the line when any written table lacks
   `cols`; `render()` appends it.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass (the flag-declarations test still
      reads the help texts).
- [x] Unit: `tableHelp` — none / one unhinted / all hinted / two unhinted.
- [x] `gws-axi docs write --help` shows the `markdown:` block.

## Risks / unknowns

None.

## Notes

- The `markdown:` block's lines don't start with `--`, so the flag-declaration parser
  ignores them (`write` is `flags: "self"` anyway).

## Follow-ups

- Tracked as: `fit` columns (`<!-- cols: fit 1 -->`) — next plan, `docs-table-fit`.
