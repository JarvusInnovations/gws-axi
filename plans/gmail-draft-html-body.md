---
status: done
depends: []
specs:
  - specs/commands/gmail-draft.md
issues: []
pr: 51
---

# Plan: gmail draft — multipart/alternative body with rendered markdown

## Scope

**In:** rebuild `buildRawMessage()` to emit `multipart/alternative` (markdown source as
`text/plain`, rendered HTML as `text/html`), add a markdown→HTML renderer, and correct
`DRAFT_HELP` — which currently documents the plain-text behavior being replaced.

**Out:** a `--plain` literal-text mode, attachments, inline images, and any change to the
command's response shape. All noted under "Out of scope" in
[`specs/commands/gmail-draft.md`](../specs/commands/gmail-draft.md).

## Implements

- [`specs/commands/gmail-draft.md`](../specs/commands/gmail-draft.md) — the whole spec, which
  is new (the command was previously unspecified). The load-bearing sections are
  **Message structure** and **Body rendering**.

## Approach

1. **Add `marked`** (`bun add marked`) — GFM-capable, ESM, dependency-free, and the natural
   inverse of the `turndown` already used on the read side. Its own commit, with the command
   in the body, per repo convention.

2. **`src/commands/gmail/compose.ts`** — replace the single-part builder:

   - `renderMarkdown(body)` → `marked.parse(body, { gfm: true, breaks: true, async: false })`,
     wrapped in `<html><body>…</body></html>`.
   - `boundary()` → `` `=_gws-axi_${randomUUID()}` `` (`node:crypto`). Unique per message,
     so no content scan or retry.
   - `encodePart(text)` → base64, CRLF-wrapped at 76 columns — the existing body encoder,
     lifted out so both parts share it.
   - `buildRawMessage()` assembles headers (`Content-Type: multipart/alternative;
     boundary="…"`), then plain part, then HTML part, then the closing `--<boundary>--`.
     Address/subject handling is untouched.

3. **`src/commands/gmail/draft.ts`** — update `DRAFT_HELP`: the `notes:` block currently
   promises "Body is sent as plain text … markdown is preserved verbatim, not rendered to
   HTML", which becomes false. Replace with the markdown contract plus the explicit
   **do not hard-wrap the body** instruction the spec requires.

4. **`src/commands/gmail/compose.test.ts`** — `decodeRaw` assumes a single base64 body and
   must be reworked to split on the boundary and decode both parts.

## Validation

- [x] `buildRawMessage` emits `Content-Type: multipart/alternative` with a `boundary=` that
      appears in the body as `--<boundary>` twice and `--<boundary>--` once.
- [x] The `text/plain` part decodes to the `--body` source **byte-for-byte**, including its
      original newlines.
- [x] The `text/html` part decodes to HTML in which `**bold**` is `<strong>`, a blank-line gap
      starts a new `<p>`, and a single newline inside a paragraph is a `<br>` (`breaks: true`).
- [x] A paragraph longer than 76 characters survives the round trip with **no CRLF inside the
      decoded text** of either part — the 76-column wrapping is base64 transport only.
- [x] Non-ASCII bodies (`café ☕`, em dashes) round-trip intact through both parts, and a
      non-ASCII `--subject` is still RFC 2047 encoded.
- [x] Part order is `text/plain` before `text/html`.
- [x] `raw` is still valid base64url (no `+`, `/`, or `=`).
- [x] `DRAFT_HELP` no longer claims markdown is preserved verbatim, and states the
      no-hard-wrapping rule.
- [x] `bun run test` and `bun run build` pass.
- [ ] **Live**: a draft created against a real account, read back with
      `gmail read <id> --raw`, shows both MIME parts; sending it produces a received message
      whose HTML part has no hard line breaks inside a paragraph.

## Risks / unknowns

- **Gmail composer round-trip** — the whole fix rests on Gmail keeping the HTML part when a
  human opens and sends the draft. Verified indirectly (Gmail's own composer emits exactly
  this structure), but the live validation criterion is the real check and must not be
  skipped.
- **`breaks: true` and pre-wrapped bodies** — an agent that hard-wraps its `--body` gets those
  breaks preserved as `<br>`, reproducing the original defect. Mitigated by documentation
  only (`DRAFT_HELP`), not enforced; watch whether it needs a heuristic un-wrapper later.
- **Markdown false positives** — prose containing `*`, `_`, or a leading `#` renders as
  formatting. The deferred `--plain` mode is the escape hatch if this bites in practice.

## Notes

- **Root cause was Gmail, not gws-axi.** The stored draft body was never wrapped — decoding an
  unsent gws-axi draft showed paragraphs of 100/208/230/272/413/369 chars. Gmail hard-wraps at
  ~70 columns *on send*, but only for a single-part `text/plain` message. That is why the
  defect was invisible in the compose window and why no amount of input normalization would
  have fixed it.
- `marked` renders `breaks: true` as `<br>` (not `<br/>`); the tests assert the exact form.
- The live draft used for validation is in Drafts as "gws-axi multipart test"
  (`draft_id r8284951195750828614`, message `19ff695736c48e16`), addressed to the account
  itself. Delete it once the send check is done.

- The final validation box (send → inspect received message) stays **unchecked**: gws-axi
  cannot send by design ([principles.md#gmail-send-out-of-scope-by-design](../specs/principles.md#gmail-send-out-of-scope-by-design)),
  so it needs a human to press send. Everything short of the send is verified — Gmail stored
  and returned both MIME parts intact, with unbroken paragraphs in the HTML.

## Follow-ups

- Issue [#54](https://github.com/JarvusInnovations/gws-axi/issues/54) — `--plain` mode that
  keeps `multipart/alternative` but builds the HTML part structurally, for bodies whose
  `*`/`_`/`#` are meant literally.
