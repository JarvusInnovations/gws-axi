---
status: in-progress
depends: []
specs:
  - specs/commands/docs-tabs.md
  - specs/commands/docs-write.md
issues: [101]
---

# Plan: Tab management — placement on `--new-tab`, and `docs tabs`

## Scope

# 101: let `docs write --new-tab` place the new tab (and give it an emoji), and add a
`docs tabs` group — list, `update` (position, parent, title, emoji), `delete`. One placement
vocabulary shared by both.

**Out of scope:** an empty-tab verb (`docs write --new-tab --content ""`), retitling the
first tab from `docs create`, any content operation.

## Implements

- `specs/commands/docs-tabs.md` — the three subcommands.
- `specs/commands/docs-write.md` § Placing a new tab — the `--new-tab` ride-along flags and
  the `tabs[N]` block in the write response.

## Approach

1. **Shared tab model** (`src/commands/docs/tabs.ts`): extend the three-level fetch to carry
   `index`, `parentTabId`, `iconEmoji`; a flattened `TabInfo` list with depth-first order and
   sibling lookups; the listing renderer (`tabs[N]{id,title,index,parent,emoji}`), used by
   `docs tabs`, the write response, and the error payloads.
2. **Placement resolver** (pure, unit-tested): from the flags, the flat list, and the moving
   tab (or none, for a new tab) → `{ parentTabId, index }` or "already there", plus the
   `TAB_NOT_FOUND` / `TAB_CYCLE` checks. The index rules are the upstream table in the spec.
3. **`docs write --new-tab`**: `parseWriteFlags` gains the placement and `--emoji` flags for
   `write` (with the targeted hint when they appear without `--new-tab`); the
   `addDocumentTab` request carries `index`, `parentTabId`, `iconEmoji`; the response adds
   `tab_index` and the listing.
4. **`src/commands/docs/tab-ops.ts`**: `docsTabsCommand` (list), `docsTabsUpdateCommand`,
   `docsTabsDeleteCommand`, reusing `readState`/`batch` from `write.ts` (exported). Local
   no-op detection; undo line built from the pre-read.
5. **Dispatcher**: `tabs`, `tabs update`, `tabs delete` entries; `docsCommand` matches the
   two-word name first. `flag-declarations.test.ts` covers them through `SUBCOMMANDS`.
6. README, CLAUDE.md status, `DOCS_HELP`, close out `docs-write.md`'s out-of-scope bullets.

## Validation

- [ ] `bun run build`, `lint`, `format:check`, `test` pass.
- [ ] Unit: placement resolver — each flag against a fixture tree (first/last/before/after,
      under, top-level, same-parent no-op, cross-parent move, cycle, unknown anchor).
- [ ] Unit: `docs write` flag parsing — placement without `--new-tab` is refused with the
      hint; conflicting placement flags refused.
- [ ] Live (scratch Doc, <chris@jarv.us>): `docs write --new-tab "R2" --first --emoji 📝`
      lands at index 0 with the icon and the response lists the tabs.
- [ ] Live: `docs tabs` lists a nested Doc with `parent` and `emoji`; `update --after`,
      `--under`, `--top-level --first`, `--title`, `--no-emoji` each produce the documented
      response; re-running the same call is `unchanged`; the undo line restores the
      previous state.
- [ ] Live: `delete` on a parent → `TAB_HAS_CHILDREN`; with `--with-children` lists both;
      the only tab → `LAST_TAB`; an unknown id → `TAB_NOT_FOUND`.
- [ ] Live: `docs tabs update … --emoji "🚀🚀"` → `INVALID_EMOJI`, nothing else changed.

## Risks / unknowns

- **Depth cap**: the fetch is masked three levels deep (as `drive upload`'s guard). A target
  below that is reported not found; acceptable, disclosed in the spec.
- **`--last` arithmetic**: the index sent is the destination parent's sibling count, counting
  the moving tab when it is already there (the API accepts `index == count`). Unit-pinned.

## Notes

(At closeout.)

## Follow-ups

(At closeout.)
