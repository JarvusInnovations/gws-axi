# Behavior: Markdown to Doc

## Rule

Every `docs` command that takes Markdown — `docs create`, `docs write`, `docs append` — turns it
into a Google Doc through **one converter**, owned by gws-axi, that issues Docs API editing
requests against a single tab. The same Markdown produces the same Doc content from each of
them.

Google's own Markdown importer is reached only by name, through `drive upload --convert`, and
that output is not expected to match. The verb names the converter.

## Applies to

- [docs create](../commands/docs-write.md#docs-create), [docs write](../commands/docs-write.md),
  [docs append](../commands/docs-write.md#docs-append) — the writers.
- [docs read](../commands/docs-read.md) — the reader, which is the converter's inverse. Its
  content rules are the ones below, read backwards.
- [drive upload --convert](../commands/drive-upload.md) — explicitly *not* governed; it carries a
  pointer here.

## Why gws-axi owns the converter

Drive's importer can only replace a whole file. A tab, an appended section, or a new Doc with
tabs cannot be written through it, so a converter that emits Docs API requests is required
anyway. Once it exists, making it the single path keeps every `docs` writer consistent with
every other and with the reader, and leaves its fidelity under gws-axi's control instead of
Google's.

## Fidelity target: round-trip through `docs read`

The converter is correct when Markdown written through it and read back with `docs read` is
the same Markdown, after normalization:

- Heading text loses any emphasis wrappers (Google's own exporter adds `**` around headings
  from the theme's heading style; the content is the heading text).
- List markers are `-` for bullets and `1.` for every ordered item; numbering is not preserved.
- A table's alignment row is `| --- |` per column; the header row carries no emphasis markers.
- Inside a table cell, lines are joined with `<br>` (a `<br/>` or `<br />` in the source reads
  back as `<br>`); list items in a cell read back as `- `, `1. ` or `- [ ] ` lines.
- A column-width hint reads back as whole percentages (`<!-- cols: 25% 75% -->`), whatever
  form it was written in; a table with evenly distributed columns reads back with no hint.
- Every list item is on its own line, indented two spaces per level.
- Trailing whitespace on a line and runs of more than one blank line are collapsed.

Google's exporter (`docs download --as text/markdown`) is a secondary check, not the target: it
round-trips most of the same constructs but drops a few (noted below), and it exports every tab
at once.

## Construct mapping

| Markdown | In the Doc | Round-trips through `docs read` | Note |
| --- | --- | --- | --- |
| `#`…`######` | Paragraph with named style `HEADING_1`…`HEADING_6` | ✅ | Google's exporter wraps the text in `**`/`*` per the theme; normalized away |
| Paragraph | `NORMAL_TEXT` paragraph | ✅ | Soft line breaks inside a paragraph are joined with a space |
| Hard line break (`  ⏎` or `\⏎`) | Vertical tab (`\u000b`) inside the paragraph | ✅ | The same encoding Google's importer uses |
| `**bold**`, `*italic*`, `~~struck~~` | Text style `bold` / `italic` / `strikethrough` | ✅ | |
| `` `code` `` | Text style font `Roboto Mono` | ✅ | Matches Google's importer; any monospace family reads back as code |
| `[text](url)`, `<url>`, bare URLs | Text style `link.url` | ✅ | Reference-style links are resolved before conversion |
| `- item`, `* item` | List item with preset `BULLET_DISC_CIRCLE_SQUARE` | ✅ | |
| `1. item` | List item with preset `NUMBERED_DECIMAL_NESTED` | ✅ as `1.` | Start numbers are not preserved |
| Nested list (indented items) | Nesting level 1…8 of the same list | ✅ | Nesting deeper than the API allows is flattened to the deepest level and disclosed |
| `- [ ] task`, `- [x] task` | List item with preset `BULLET_CHECKBOX` | ✅ as `- [ ]` | **The checked state cannot be set through the API**; every task is written unchecked and the count of checked tasks is disclosed |
| `> quote` | `NORMAL_TEXT` paragraph indented 30pt start, first line, and end | ✅ | The exact indents Google's importer uses, which is what its exporter turns back into `>` |
| Fenced or indented code block | One `NORMAL_TEXT` paragraph per line, every run in `Roboto Mono` | ✅ (fence, no language) | **Not** a native Docs code block. Docs has one (with a language selector), and Google's importer creates it, but the Docs API can neither create one nor read one back, so the language is disclosed as dropped |
| `\| table \|` | Table, first row bold and pinned as the header row; cells carry only the style their own Markdown asks for | ✅ | `docs read` does not re-emit the header row's bold, since a GFM header is bold by construction. A table may be the only block, the first, or the last |
| `<br>` inside a cell | A hard line break (`\u000b`) in the cell's paragraph — the same encoding as a hard break outside a table | ✅ as `<br>` | GFM's de facto multi-line cell. A line break, not a paragraph: no paragraph spacing opens up between the lines |
| `<!-- cols: 1 3 -->` or `<!-- cols: 25% 75% -->` on the line(s) before a table | Fixed column widths: the tab's content width (page width minus the side margins) split in those proportions | ✅ as percentages | Markdown has no width syntax, so this is a gws-axi extension in the one form every other renderer ignores. The hint must name exactly one width per column and must be followed by a table — anything else is refused before the write (`VALIDATION_ERROR`), never written as text. Without a hint, columns are evenly distributed (Docs' default) |
| `fit` in a `cols` hint (`<!-- cols: fit 1 -->`) | That column sized to its widest line (§ Fitted columns); the other columns share what is left in their proportions | ✅ as a percentage | The fit is computed at write time from measured text, not by Docs; a column a human later lengthens does not grow. All-`fit` makes a table narrower than the page |
| `- item<br>- item` (or `1. `, `- [ ] `) inside a cell | One bulleted paragraph per item in the cell, with the list preset of the marker; a non-item line before or after the items is its own paragraph | ✅ | Flat lists only: the API's nesting-by-leading-tab does not take inside a cell, so an indented item is written at level 0 and disclosed. Images and footnotes in a cell are still written as text |
| `---` | An empty paragraph with a bottom border | ✅ | Google's exporter drops it. There is no API request that inserts Docs' own horizontal rule |
| `![alt](https://…)` | Inline image fetched by Google from the URL | ✅ as `[image]` (alt can't be written; an image that has alt reads back as `[image: alt]`) | Only `http(s)` URLs; a local path or `data:` URL is refused (`IMAGE_NOT_FETCHABLE`). A URL Google cannot fetch fails the write with the same code. The API's insert takes no alt text; a non-empty `alt` is disclosed as dropped |
| `[^1]` and its definition | A Docs footnote | ✅ | `docs read` renders the definitions at the end, numbered in citation order |
| Inline HTML | Written as literal text | ✅ as text | Disclosed |
| `<u>text</u>` | Text style `underline` | ✅ | The one HTML tag with a Doc equivalent, because `docs read` emits it |

Anything not in the table is written as its plain text, never dropped, and counted in the
disclosure.

### Fitted columns

A `fit` column is as wide as its widest line needs, measured by gws-axi — the Docs API has no
auto-fit. The measurement:

- **Metrics:** Helvetica and Helvetica-Bold advance widths (Adobe's Core 14 AFM tables; Arial,
  Docs' default body font, is metric-compatible with Helvetica). ASCII is exact; an accented
  Latin letter measures as its base letter (`é` as `e`); anything outside Latin (CJK, emoji)
  measures as one em. Bold runs — and every cell of the header row — use the bold table.
- **Size** is the tab's `NORMAL_TEXT` font size (11pt by default).
- **A line** is a cell paragraph, or one segment of it between hard breaks; a list item adds
  the 36pt a bulleted cell paragraph is indented.
- **Width** = widest line × 1.06 + 2pt + Docs' cell padding (5pt a side), floored at 24pt and
  rounded up; the 6% + 2pt is the margin for any proportional font a tab may use instead of
  Arial — they sit in the same range, and a too-narrow column wraps while a slightly wide one
  costs nothing. When the tab's body font is neither Arial nor Helvetica the response says
  the fit was measured as Arial, so a wrapped column is explained and the hint can be widened.
- The non-`fit` columns share the remaining content width in their proportions; if the fits
  alone would leave them under 24pt each, the fits are scaled down to leave that.

This is a gws-axi-side estimate of Docs' layout, and it is not a house style: no font other
than the platform default is assumed, by design.

### Spacing is a paragraph property

The converter never writes an empty paragraph to make vertical space, and never leaves behind
one that the API created. Space between blocks comes from the tab's named styles (Docs' own
default is `NORMAL_TEXT` with 10pt below), and from an explicit `spaceAbove`/`spaceBelow` on
the one paragraph where a structure interrupts that rhythm:

- **No gap at the top.** The first paragraph written at the start of a tab has no space above
  it, whatever its style. Docs' heading styles carry space-above, so a Doc that opens with a
  heading — as most written from Markdown do — otherwise starts with a blank gap that has to
  be removed by hand every time. Google's importer leaves that gap; this converter does not. A
  paragraph appended below existing content keeps its style's normal spacing.
- **Nothing before a table.** `insertTable` splits off an empty paragraph above the table; the
  converter removes it by deleting the newline that ends the preceding paragraph, which keeps
  that paragraph's style. Where it cannot — a table that opens a tab, where the paragraph
  above it is the tab's first, or the second of two adjacent tables, whose stray sits between
  the tables — the paragraph is kept at zero spacing and a 1pt font so it takes no visible
  room; `docs read` never renders it as a blank line.
- **Space after a table.** A Docs table has no bottom margin, so the paragraph that follows one
  gets `spaceAbove` equal to the tab's `NORMAL_TEXT` space-below — unless it is a heading,
  whose own style already carries space above.

A `docs read` of a Doc written this way has no blank-line artifacts to round-trip.

## Upstream gaps

Four constructs exist in Docs, and Google's importer creates them, but the Docs API cannot write
them. Each is tracked with the `upstream-blocked` label so the converter can adopt it when the
API does: native code blocks with a language (#83), checked tasks (#84), image alt text (#85),
and a native horizontal rule (#86). Each issue names the discovery revision last checked.

## Disclosure

A write reports what did not survive conversion as `lossy[N]{construct,count,handling}` — for
example `checked_task,3,written unchecked` or `code_language,1,dropped`. When nothing was lost
the list collapses to `lossy: none`. This is
[surface-completeness-limits](../principles.md#surface-completeness-limits) applied to a write:
the Doc is still produced, and the caller is told exactly what to look at.

## Atomicity

A write is applied as a single `batchUpdate` wherever the API allows, so a failure leaves the
tab untouched. Tables and footnotes need a second request after the Doc has assigned their
cells and ids; a failure between the two is reported as `WRITE_INCOMPLETE`, naming the
revision to compare with `docs diff`. It is never silent.

Every write names the document revision it read before converting, so a document edited by
someone else in the meantime is refused (`DOCUMENT_CHANGED`) rather than overwritten; the
suggestion is to re-read and re-run.

A `--new-tab` write converts before it adds the tab, so anything the converter refuses fails
with no tab added. If the content write fails after the tab exists, the tab is deleted again
and the error says so; a failed deletion is named in the same error, with the tab id, so
nothing is left behind unmentioned.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| `addDocumentTab`, `updateDocumentTabProperties`, `deleteTab` exist and work under user OAuth; the add reply carries the new `tabId` | **Observed 2026-10-02** |
| `updateTableColumnProperties` with `columnIndices` and `widthType: FIXED_WIDTH` + `width` (PT) sets one column's width and reads back as `tableStyle.tableColumnProperties[i]`; `EVENLY_DISTRIBUTED` restores the default; a tab's `documentStyle` carries `pageSize.width` and `marginLeft`/`marginRight` (612 − 72 − 72 = 468pt on a default page) | **Observed 2026-10-08** |
| `insertText` into a table cell with `\n` in the text makes one cell paragraph per line; `\u000b` is a hard break there as in the body; `createParagraphBullets` over cell paragraphs bullets them at level 0; the leading-tab nesting trick does **not** nest inside a cell (the tab is kept as text, the level stays 0) | **Observed 2026-10-08** |
| `insertText`, `updateParagraphStyle`, `updateTextStyle`, `createParagraphBullets`, `insertTable`, `createFootnote`, `insertInlineImage`, `deleteContentRange` all accept `tabId` and act on that tab only | Observed |
| `deleteContentRange` from index 1 to the body's end − 1 empties a tab, leaving one empty paragraph; list definitions left behind are harmless | Observed |
| A leading tab character per level in inserted text, followed by `createParagraphBullets` over the range, sets the item's nesting level | Observed: levels 0, 1, 2 |
| `BULLET_CHECKBOX` creates a checkbox list; the Docs API exposes no checked state on a list item | Observed (preset); the checked state of an imported `- [x]` is invisible in `documents.get` |
| Google's importer encodes a blockquote as 30pt start/first-line/end indents, a hard break as `\u000b`, inline code and code blocks as `Roboto Mono` runs, and bolds a table's first row with `tableHeader` set | Observed in a `drive upload --convert` of a probe file |
| Google's exporter turns a 30/30/30pt-indented paragraph back into `>` but a 36/36pt one into plain indented text | Observed |
| Docs stores native code blocks with a language, and tasks with a checked state. Google's importer creates both from Markdown and its exporter renders both back (` ```js `, `- [x]`). The Docs API exposes neither: `documents.get` returns the importer's code block as plain `Roboto Mono` paragraphs and its tasks as `BULLET_CHECKBOX` items with no state, and no `batchUpdate` request sets either | **Observed 2026-10-02**, against the live discovery document (revision 20260928): no code-block or checked-state field in any schema or request |
| A heading at the top of a Doc shows its named style's space-above as a visible gap; `paragraphStyle.spaceAbove: 0pt` on that paragraph removes it without changing the style | **Observed 2026-10-02**: the paragraph reads back with `spaceAbove` 0 and the style intact |
| Google's exporter drops a continuous section break, and drops a bottom-bordered empty paragraph too | Observed: neither comes back as `---` |
| Because of the row above, Google's exporter fences only native code blocks: monospace paragraphs written through the API come back as inline code per line, whatever their spacing or newline styling | Observed: three encodings tried, none fenced |
| `insertTable` at a paragraph's start inserts a newline before the table; the new empty paragraph inherits the style and bullet of the paragraph it split off, and **the new cells' paragraphs inherit its text style too** (bold text after the table makes every cell bold) | Observed: a rule paragraph doubled until the new one was reset; **Observed 2026-10-08**: cells read back `bold: true` with no text of their own |
| The empty paragraph before an inserted table cannot be deleted by its own range (400 `Cannot delete the requested range`), but deleting the newline that ends the *preceding* paragraph merges the two, and the merged paragraph keeps the preceding one's style — a `HEADING_1` stays a heading with the table directly below it | **Observed 2026-10-08** |
| `insertText` with empty `text` is a 400 (`Insert text requests must specify text to insert`) | **Observed 2026-10-08** |
| A fresh Doc's `NORMAL_TEXT` named style is 0pt above / 10pt below / line spacing 115; named styles are per tab, and `updateNamedStyle` with `tabId` changes one tab's (the mask must include `namedStyleType`) | **Observed 2026-10-08** |
| `batchUpdate` is atomic: all requests apply or none | Documented |
| `writeControl.requiredRevisionId` refuses a request against a stale revision with a 400 whose message says the id "does not match the latest" | **Observed 2026-10-02** |
| A vertical tab in `insertText` is accepted and stored as a hard line break; Google's exporter renders it as two trailing spaces and a newline | Observed |
| `createParagraphBullets` removes the nesting tabs it consumed, shifting every later index | Observed; the converter emits it last, in descending order |

## Principles

**Inherited:**

- [surface-completeness-limits](../principles.md#surface-completeness-limits) — every construct
  that cannot be represented is written as text and named in `lossy[]`.
- [single-source-of-truth-helpers](../principles.md#single-source-of-truth-helpers) — one
  converter module feeds all three writers; the reader's rules are the same table reversed.

**Local:**

- **The verb names the converter.** Markdown becomes a Doc through gws-axi's converter under
  `docs`, and through Google's importer only under `drive upload --convert`. No command switches
  engines on the source's extension.

  > **Why:** Two engines that can be reached from one verb give an agent no way to know which
  > formatting it will get, and no way to report which it got. Keeping each behind its own verb
  > makes the output predictable and lets `drive upload` stay what it is: bytes handed to Drive.

- **Round-trip beats parity.** The converter is measured against `docs read`, not against what
  Google's importer would have produced. Matching Google's output is a treadmill with no owner;
  a round-trip is a test gws-axi can run.

- **Space is a paragraph property, never an empty paragraph.** The converter makes vertical
  space with `spaceAbove`/`spaceBelow` — the tab's named styles, or an explicit value where a
  structure interrupts them — and removes the empty paragraphs the API creates on the way.

  > **Why:** blank paragraphs are the formatting the owner removes by hand from every Doc that
  > arrives with them. They are invisible structure that `docs read` has to guess about, they
  > break when a style changes, and a Doc written through gws-axi is meant to carry the owner's
  > style preferences, not Google's importer's.
