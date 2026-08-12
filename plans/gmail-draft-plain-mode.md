---
status: done
depends: [gmail-draft-html-only]
specs:
  - specs/commands/gmail-draft.md
issues: [54]
pr: 59
---

# Plan: `--plain` literal-text mode for gmail draft

## Scope

**In:** a `--plain` flag that turns markdown interpretation off, for bodies whose `*`, `_`,
`#`, or backticks are meant literally.

**Out:** attachments, inline images. No change to the message structure, the response shape,
or the default (markdown) path.

## Implements

- [`specs/commands/gmail-draft.md`](../specs/commands/gmail-draft.md) — the `--plain` flag and
  the new "Literal-text mode" section. Removes the matching "Out of scope" entry.

## Approach

`renderPlainText(body)` alongside the existing `renderMarkdown(body)`; `buildRawMessage`
picks between them on `fields.plain`. Everything else about the message is unchanged.

The rendering rules and why each one is load-bearing:

| Rule | Why |
| --- | --- |
| Still a single `text/html` part | Sending `text/plain` is the original defect ([`gmail-draft-html-body`](gmail-draft-html-body.md)); adding a plain *alternative* reopens the composer coin flip ([`gmail-draft-html-only`](gmail-draft-html-only.md)). Neither is permitted. |
| Escape `&`, `<`, `>` | Markup in the body must display, not render |
| Blank line → `<p>`, newline → `<br>` | Same block semantics as the markdown path — `--plain` changes what characters *mean*, not where text sits |
| Leading spaces → `&nbsp;`; internal runs keep one real space | HTML collapses whitespace, destroying exactly the aligned text this mode carries. One real space per run stays a wrap point so lines still reflow. Mirrors what Gmail does converting plain text to HTML, so it is known to survive the composer. |
| Tabs → four spaces | Tabs collapse in HTML like any other whitespace |

## Validation

- [x] `--plain` still emits a single `text/html` part — no `multipart`, no `text/plain`.
- [x] `**bold**`, `[link](url)`, and `_underscores_` survive as literal text; no `<strong>`
      or `<a href>` appears.
- [x] A leading `#` or `-` does not become a heading or list item.
- [x] `<script>`/`<b>` in the body are escaped and reach the reader as text.
- [x] Blank line → new `<p>`; single newline → `<br>` — same as the markdown path.
- [x] Indentation survives: `calories   1,895` keeps its four-space indent as `&nbsp;`
      and its internal column gap.
- [x] Tabs expand; whitespace-only blocks drop; an empty body yields an empty document.
- [x] `--help` lists `--plain` and the flag count matches.
- [x] `bun run test` (232 passed) and `bun run build` pass.
- [ ] **Live**: a `--plain` draft sent from the Gmail UI arrives with markdown syntax intact
      and indentation preserved.

## Risks / unknowns

- **`&nbsp;` padding vs. Gmail's sanitizer** — the technique is copied from Gmail's own
  plain-to-HTML conversion (observed on a real message), so it should round-trip, but this
  specific shape has not been sent end to end. See the unchecked criterion.
- **Discoverability** — an agent hitting mangled output will more likely rewrite the body than
  find `--plain`. `--help` names the trigger conditions (`*`, `_`, `#`, backticks) rather than
  just the flag, so the fix is findable from the symptom.

## Notes

- The structure question was already settled by [`gmail-draft-html-only`](gmail-draft-html-only.md);
  this plan deliberately does not revisit it. The spec states the prohibition explicitly
  because "plain mode sends text/plain" is the obvious-looking implementation and is wrong.
- The live criterion stays unchecked: gws-axi cannot send by design, so it needs a human. The
  *structure* is already verified end-to-end by the previous plan — what is unverified here is
  only whether Gmail preserves the `&nbsp;` padding.

## Follow-ups

None.
