# Command: docs replace-text

## Summary

Replace every occurrence of a literal string in **one tab** of a Doc, keeping all formatting —
the Docs API's own `replaceAllText`, scoped by `tabsCriteria`. From issue #108: an agent that
maintains a status table on a tab humans also edit cannot rewrite the tab (`docs write` would
discard their column widths, styles and recent edits), but can flip `Generating` → `Refining`
in place. This is the first surgical edit; `edit-cell` (#108, second half) is its own spec.

No new scope: `documents.get` + `documents.batchUpdate` under the existing `documents` grant.

## Invocation

```
gws-axi docs replace-text <documentId> --find <text> --replace <text> [--tab <id>] [--all] [--ignore-case] [--account <email>]
```

- `--find <text>` — REQUIRED, a literal substring (no pattern syntax); empty is a
  `VALIDATION_ERROR`.
- `--replace <text>` — REQUIRED; may be the empty string, which deletes the matched text.
- `--tab <id>` — the tab to edit, as `docs tabs` lists it. The same rule as `docs write`:
  omitted on a single-tab Doc → that tab; omitted on a multi-tab Doc → `TAB_REQUIRED` with the
  listing, nothing written. Never a title.
- `--all` — replace every occurrence. Without it, more than one match is refused
  (`MULTIPLE_MATCHES`) — see Behavior.
- `--ignore-case` — match case-insensitively. Default is case-sensitive: a surgical edit names
  exactly what it changes.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `replaceAllText` with `tabsCriteria.tabIds: [<id>]` replaces in that tab only — its body, headers, footers and footnotes — and the reply's `occurrencesChanged` counts what it replaced | Observed (see plan) |
| The replacement text takes the text style of the text it replaces (bold stays bold, a link stays a link) | Observed |
| `replaceAllText` accepts an empty `replaceText` and deletes the matches | Observed |
| `containsText.matchCase: false` matches case-insensitively; the replacement is inserted as given | Observed |
| `writeControl.requiredRevisionId` guards the request as it does every other write | Documented; same mechanism as `docs write` |

## Behavior

1. **Read**: one `documents.get` with `includeTabsContent: true` — the tab tree, the target tab's
   text (body, headers, footers, footnotes, table cells included, recursively), and
   `revisionId`.
2. **Count locally**: every occurrence of `--find` in that tab, each with the paragraph it is in
   and a short context (the matcher `docs find` uses, which now also walks table cells).
3. **Decide**:
   - 0 matches → `action: no_match`, nothing written, exit 0. The absence of the old text is
     the state the caller wanted; the response says what was searched so a typo is visible.
   - 1 match, or `--all` → write.
   - 2+ matches without `--all` → `MULTIPLE_MATCHES`, listing every match with context; nothing
     written. The suggestions are the same call with `--all`, and a longer `--find` that
     includes surrounding words to single one out.
4. **Write**: one `batchUpdate` with one `replaceAllText` (`containsText{text, matchCase}`,
   `replaceText`, `tabsCriteria{tabIds: [tab]}`) under `writeControl.requiredRevisionId` from
   the read → `DOCUMENT_CHANGED` if the Doc moved in between.
5. **Reconcile**: the reply's `occurrencesChanged` is the number reported. If it differs from
   the local count (it should not; headers and footnotes are counted too), the response says
   so in a note rather than hiding either number.

The command never touches formatting: the replaced text keeps the style of what it replaced,
and nothing else in the tab changes. It is **not idempotent in the general case** — re-running
after success finds nothing (`no_match`), but if `--replace` text already occurred before the
call, an undo by swapping the two strings would also hit those; the undo line says so.

## Output

```
account: alice@example.com
action: replaced
document:
  id: 1BxAbc…
  title: Roadmap
  tab: t.k3j2
  tab_title: Status
  revision_id: ALBJ4Lu…
occurrences: 1
matches[1]{paragraph,context}:
  12,"…status: Generating (round 3) → …"
help[3]:
  Verify: `gws-axi docs read 1BxAbc… --tab t.k3j2`
  Compare with the version before: `gws-axi docs diff 1BxAbc… ALBJ4Lt…`
  Undo (if "Refining" did not already occur in the tab): `gws-axi docs replace-text 1BxAbc… --find "Refining" --replace "Generating" --tab t.k3j2 --all --account alice@example.com`
```

- `action` — `replaced` or `no_match`.
- `occurrences` — what was replaced (from the reply); `0` on `no_match`.
- `matches[N]{paragraph,context}` — each occurrence **as it read before the replacement**, so
  the response is the record of what changed; omitted on `no_match`.
- `revision_id` — the head revision after the write
  ([provenance-by-default](../principles.md#provenance-by-default)); on `no_match` the revision
  read.
- `occurrences_note` — only when the reply's count differs from the local count.

On `no_match`:

```
action: no_match
document: {…}
occurrences: 0
searched: "Generating" (case-sensitive) in tab t.k3j2
help[2]:
  Run `gws-axi docs find 1BxAbc… --query "Generating" --tab t.k3j2` to look for near-misses (case-insensitive)
  Pass --ignore-case to match regardless of case
```

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | Missing document id, `--find`, or `--replace`; empty `--find`; unknown flag |
| `DOCUMENT_NOT_FOUND`, `NON_NATIVE_DOCUMENT` | As `docs write` |
| `TAB_REQUIRED` | Multi-tab Doc without `--tab`; carries the listing |
| `TAB_NOT_FOUND` | `--tab` names no tab; names the available ids |
| `MULTIPLE_MATCHES` | 2+ occurrences without `--all`; lists them with context; nothing written |
| `DOCUMENT_CHANGED` | The Doc's revision moved between the read and the write; nothing written |

All Google failures pass through `translateGoogleError`.

## Dispatcher

A new `{ mutation: true }` entry `replace-text` with its own flag declaration. The
`insert-text` / `delete-range` stubs' `instead[]` gain this command as the formatting-safe path
for a text change.

## Out of scope

- Patterns (regex, wildcards): `--find` is literal. A pattern would make "what will this change"
  unanswerable before the write.
- More than one tab per call; replacing across the whole Doc. One conversation of change per
  call, by id, as everywhere else.
- Replacing by position (`@N` refs from `docs find`): a later `insert-text` / `delete-range`
  concern.

## Principles

**Inherited:**

- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
- [ids-are-first-class](../principles.md#ids-are-first-class) — the tab by id.
- [provenance-by-default](../principles.md#provenance-by-default) — `revision_id` after, the
  `docs diff` line with the revision before.
- [contextual-help-suggestions](../principles.md#contextual-help-suggestions) — verify, diff,
  undo.
- [fail-loud-on-unknown-flags](../principles.md#fail-loud-on-unknown-flags)

**Local:**

- **A surgical edit names what it will change before it changes it.** More than one match is
  refused unless `--all` says so, and the response lists each occurrence as it read before the
  write.

  > **Why:** `replaceAllText` is global within its scope and has no preview. An agent asked to
  > "mark me done on v3" must not also mark v2; the count check is what makes a one-line change
  > safe to run from a prompt.
