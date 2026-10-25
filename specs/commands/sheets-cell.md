# Command: sheets cell

## Summary

The detail view for **one cell**: what was entered, what it evaluates to, and — when it is a
formula — the current values of every cell it references. `sheets read` is the list view; this
is where an agent goes to find out *why* `D2` shows `#VALUE!`, or to confirm what a formula it
wrote is actually computing from. One call, no scope beyond `spreadsheets`, read-only
([read-only-stays-read-only](../principles.md#read-only-stays-read-only)).

## Invocation

```
gws-axi sheets cell <spreadsheetId> <A1> [--tab <name|gid>] [--depth <n>] [--account <email>]
```

- `<A1>` — one cell, optionally tab-qualified (`Costs!D2`). A range is a `VALIDATION_ERROR`
  pointing at `sheets read --range`.
- `--tab` — as `sheets read`; required on a multi-tab spreadsheet when the cell is not
  qualified (`TAB_REQUIRED`).
- `--depth <n>` — how many levels of referenced formulas to expand (default `1`; max `3`).

## Data Requirements

1. `spreadsheets.get` (properties + `namedRanges`) to resolve the tab and named ranges.
2. `spreadsheets.get` with `includeGridData`, `ranges=[<cell>]`, fields
   `formattedValue, userEnteredValue, effectiveValue, note, hyperlink, dataValidation,
   userEnteredFormat.numberFormat`.
3. When the cell is a formula: the references are parsed from the formula text —
   A1 cells and ranges, tab-qualified or not, absolute `$` forms, whole columns/rows
   (`B:B`, `3:3`), open-ended ranges (`B2:B`, `A2:2`), and named ranges (resolved through step 1). Every distinct reference is
   fetched in **one** further `spreadsheets.get` with one `ranges` entry each and fields
   `formattedValue, userEnteredValue.formulaValue, effectiveValue.errorValue`. References
   inside string literals (`"A1"`) are not references. A function name is never a reference.
4. With `--depth` > 1, referenced cells that are themselves formulas are expanded the same
   way, breadth-first, until the depth is reached; cycles are reported, not followed.

## Display Rules

```
account: alice@example.com
cell:
  ref: Costs!D2
  formula: =B2*C2
  value: "#VALUE!"
  error: VALUE
  message: Function MULTIPLY parameter 2 expects number values. But 'n/a' is a text and cannot be coerced to a number.
  number_format: CURRENCY "$"#,##0
refs[2]{ref,kind,value,formula}:
  B2,number,"$4,200",
  C2,text,n/a,
help[2]:
  Fix: gws-axi sheets update 1AbC… --tab Costs --cell D2='=B2*C2'
  Run `gws-axi sheets cell 1AbC… C2 --tab Costs` to inspect a referenced cell
```

- `cell{ref,formula?,value,error?,message?,kind,note?,link?,number_format?,validation?}` —
  `formula` only for a formula cell (the text as entered); `value` is the displayed string;
  `error`/`message` from `effectiveValue.errorValue` when it errors; `kind` is the effective
  type (`number`, `text`, `bool`, `error`, `empty`); `note`, `link`, `number_format` and
  `validation` (a one-line summary of the rule) only when present. A non-formula cell is the
  same block minus `formula`/`refs`.
- `refs[N]{ref,kind,value,formula}` — one row per **cell** the formula references, in formula
  order. A range reference expands to its cells, capped at **20 cells** per reference (a
  `SUM(B2:B500)` shows 20; a 2-column range shows its first 10 rows); `ref_cells_total` — the
  number of cells all the level-1 references cover — is shown whenever any reference was
  capped. Whole-column (`B:B`) and open-ended (`B2:B`) references expand to the tab's data
  extent under the same cap. `formula` is filled when the referenced cell is itself a formula, so the
  chain is visible; an erroring reference shows its error as `value` and its `kind` as `error`.
- With `--depth` > 1, nested `refs` render as further `refs_<ref>[N]{…}` blocks, one per
  expanded formula cell, so each level stays flat and addressable.
- A reference to another tab is fetched like any other (`Cost!B2` → `ref: Cost!B2`); a tab
  that does not exist is the `#REF!` the formula shows, reported as `kind: error` with
  `value: #REF!` and no fetch.

### help[] suggestions

- When the cell errors: the fix line from [sheets-write.md § Formula errors](sheets-write.md#formula-errors-the-feedback-loop)
  first, carrying the current formula.
- When a referenced cell errors or is a formula: `sheets cell <id> <ref>` on it (the first
  such ref).
- When any reference was capped: `sheets read <id> --tab <t> --range <ref>` for the whole
  range.
- Always: `sheets read <id> --tab <t> --range <cell's row or neighborhood> --formulas` to
  see the formula among its neighbors.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | A range instead of a cell; unparseable A1; `--depth` outside 1–3 |
| `SPREADSHEET_NOT_FOUND`, `TAB_REQUIRED`, `TAB_NOT_FOUND` | As `sheets read` |

A reference the parser cannot resolve (an `INDIRECT(...)`, an `OFFSET` with computed
arguments) is listed as `refs` row with `kind: dynamic` and no value, never silently dropped
([surface-completeness-limits](../principles.md#surface-completeness-limits)).

## Principles

**Inherited:**

- [provenance-by-default](../principles.md#provenance-by-default) — the formula and its
  inputs are the provenance of a computed value.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — the fix line
  and the next cell to inspect are in hand.
- [ids-are-first-class](../principles.md#ids-are-first-class) — every ref is an A1 address the
  next command accepts verbatim.

**Local:**

- **A formula is explained by its inputs.** The detail view of a formula cell always shows
  the current value of what it reads, because an error message names the symptom
  (`expects number values`) and the inputs name the cause (`C2 is the text n/a`).
