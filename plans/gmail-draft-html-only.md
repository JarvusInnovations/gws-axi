---
status: done
depends: [gmail-draft-html-body]
specs:
  - specs/commands/gmail-draft.md
issues: []
pr: 56
---

# Plan: send drafts as a single text/html part

## Scope

**In:** drop the `text/plain` alternative shipped by
[`gmail-draft-html-body`](gmail-draft-html-body.md) and send a single `text/html` part;
rewrite the spec's message-structure section around what live sends actually showed.

**Out:** the deferred `--plain` literal-text mode (#54), attachments, inline images.

## Implements

- [`specs/commands/gmail-draft.md`](../specs/commands/gmail-draft.md) — "Message structure",
  "How Gmail's composer treats a draft", "Survives human editing".

## Approach

Live testing of the just-shipped `multipart/alternative` build found it **non-deterministic**.
Two drafts built identically diverged: the first kept our rendered markup end-to-end; the
second opened in the composer showing the *raw markdown source*, and delivered HTML
regenerated from the plain part — so `**bold text**` and `[link](https://axi.md)` reached the
reader literally, with the URL autolinked inside the brackets.

Gmail's composer adopts exactly one part and discards the rest, and which one is not under
our control. Since the plain part can win, shipping the markdown source there is a defect in
its own right — a worse-looking one than the wrapping it replaced.

Two candidate fixes:

1. Make the plain part a plain-text *rendering* of the markdown (both branches reader-safe).
2. Send **only** `text/html`, leaving nothing to choose between.

(2) is strictly better and was verified: it is deterministic, it always preserves the
rendering (under (1), a plain-part win still loses bold/links/lists), Gmail synthesizes a
better plain alternative than we would, and it deletes code rather than adding it.

Implementation: `buildRawMessage` emits `Content-Type: text/html` with the rendered body;
the boundary, `randomUUID` import, and part-assembly loop go away.

## Validation

- [x] `buildRawMessage` emits a single `text/html` part — no `multipart`, no `boundary`,
      no `text/plain` in the headers.
- [x] The decoded body is the rendered HTML (`<strong>`, `<a href>`, `<li>`), wrapped in
      `<html><body>`.
- [x] A paragraph longer than 76 characters has no CRLF in the decoded body.
- [x] Non-ASCII round-trips; a non-ASCII `--subject` is still RFC 2047 encoded.
- [x] `raw` is still valid base64url.
- [x] `DRAFT_HELP` no longer describes a multipart message.
- [x] `bun run test` (224 passed) and `bun run build` pass.
- [x] **Live**: draft created against a real account stores as single `text/html` with the
      rendering intact.
- [x] **Live**: the composer opens it in **rich text**.
- [x] **Live**: after a human edits it (typing mid-paragraph, adding a list item, appending
      paragraphs) and sends, the delivered message is `multipart/alternative` whose HTML part
      keeps `<p>`/`<strong>`/`<a>`/`<br>`/`<ul>`/`<li>` with paragraphs unbroken, and whose
      Gmail-generated `text/plain` part is a clean rendering (`*bold text*`,
      `link <https://axi.md>`).

## Risks / unknowns

- **Why the multipart case diverged is still unexplained.** Two samples, no isolated
  mechanism. This plan removes the ambiguity rather than explaining it, which is why the
  fix does not depend on the answer.
- **Non-Gmail send paths** — the "Gmail generates the plain alternative" guarantee is
  Gmail's behavior. A draft pulled out via API and sent by another client would go out
  HTML-only. Not a supported path today (gws-axi drafts are sent from the Gmail UI by
  design), but it is the assumption to revisit if that ever changes.

## Notes

- The earlier `multipart/alternative` reasoning was sound in principle and wrong in practice —
  it was modeled on what Gmail's composer *emits*, not on what it *accepts*. Emitting the
  shape a tool produces is not the same as feeding it the shape it round-trips cleanly.
- Both failure modes shared a root cause worth remembering: the composer silently picks a
  representation, and the compose window shows the picked one — so any defect it introduces
  is invisible exactly where a human would look for it. Verifying a compose path means
  reading the *delivered* message, never the draft or the editor.

## Follow-ups

- Issue [#54](https://github.com/JarvusInnovations/gws-axi/issues/54) — rewritten for the
  single-part structure: a `--plain` mode must still send `text/html`, built structurally
  rather than through markdown, and must never revert to `text/plain`.
