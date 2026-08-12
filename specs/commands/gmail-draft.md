# Command: gmail draft

## Summary

Composes a Gmail **draft** — the only outbound-mail verb gws-axi has. Sending is
withheld by design ([principles.md#gmail-send-out-of-scope-by-design](../principles.md#gmail-send-out-of-scope-by-design));
a human reviews the draft in the Gmail UI and presses send.

That division of labor is what makes the message's **on-the-wire form** load-bearing.
gws-axi authors the message; the human who sends it does not re-author it. Whatever
MIME structure the draft carries is what the recipient receives. So the draft is built
as `multipart/alternative` carrying a rendered `text/html` part alongside the
markdown source as `text/plain` — the shape Gmail's own composer produces — and the
`--body` markdown is rendered to that HTML.

## Invocation

`gws-axi gmail draft --to <emails> --subject <text> --body <markdown> [flags]`

## Flags

- `--to <emails>` — REQUIRED. Comma-separated recipient addresses. Empty → `VALIDATION_ERROR`.
- `--subject <text>` — subject line. Default: empty (rendered as `(no subject)` in the response).
- `--body <markdown>` — the message body, as markdown (see [Body rendering](#body-rendering)).
- `--body-file <path>` — read the body from a file instead. Mutually exclusive with `--body`.
- `--cc <emails>` / `--bcc <emails>` — comma-separated.
- `--thread <thread-id>` — attach the draft to an existing thread (a reply draft).
- `--account <email>` — REQUIRED when 2+ accounts are authenticated (this is a write —
  [principles.md#write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)).

## Message structure

The `raw` field handed to `users.drafts.create` is a base64url-encoded RFC 5322 message
with this structure:

```
From: <account>
To: <joined recipients>
[Cc: …]  [Bcc: …]
Subject: <RFC 2047 encoded-word when non-ASCII, else verbatim>
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="<boundary>"

--<boundary>
Content-Type: text/plain; charset="UTF-8"
Content-Transfer-Encoding: base64

<the --body source, verbatim, base64, wrapped at 76 columns>
--<boundary>
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: base64

<the rendered HTML, base64, wrapped at 76 columns>
--<boundary>--
```

Rules:

- **Part order is `text/plain` then `text/html`.** RFC 2046 orders alternatives least- to
  most-faithful; clients pick the last they can render.
- **The `text/plain` part is the `--body` source verbatim** — unwrapped, unmodified. Markdown
  source is readable as plain text, so this doubles as the text-only fallback.
- **The boundary is unique per message** and cannot collide with body content
  (`=_gws-axi_<uuid>`). No content scanning or boundary-retry is required.
- **Both parts are base64** with CRLF line endings, wrapped at 76 columns (RFC 2045), so
  arbitrary UTF-8 survives.

### Why not single-part `text/plain`

A single-part `text/plain` draft puts Gmail's composer into plain-text mode. On send Gmail
hard-wraps the body at ~70 columns with real CRLFs and ships **no HTML alternative**, so
the recipient sees permanently narrow, ragged columns that nothing can reflow. The Gmail
compose window shows the original unwrapped paragraphs, so the damage is invisible until
after send. Emitting the HTML alternative keeps the composer in rich-text mode and leaves
line structure under this command's control rather than the sending client's.

## Body rendering

The `--body` / `--body-file` value is **markdown**, rendered to the `text/html` part with
GitHub-flavored markdown semantics and these settings:

- **GFM on** — tables, fenced code blocks, strikethrough, autolinked URLs.
- **`breaks: true`** — a single newline inside a paragraph becomes `<br>`, not a space.
  Email bodies carry meaningful single-line breaks (signature blocks, addresses, lists of
  values); collapsing them would silently reflow content the author laid out.
- **Blank-line-separated blocks become `<p>` paragraphs**, which is what lets a client
  reflow prose to the reader's window width.
- **Raw HTML in the body passes through.** The body's author is the sender, not an untrusted
  party, so no sanitization step is imposed.
- The rendered fragment is wrapped in a minimal `<html><body>…</body></html>` document.

Because `breaks: true` honors every newline, **the body must not be hard-wrapped**: write
each paragraph as one long line and let the recipient's client wrap it. `--help` states this
explicitly, since a pre-wrapped body reproduces exactly the ragged-column defect this
structure exists to prevent.

## Display Rules

A single flat object, in order: `action: drafted`, `account`, `draft_id`, `message_id`,
`to`, `subject`, then `cc` and `thread_id` when applicable.

- `draft_id` and `message_id` are first-class and never truncated
  ([principles.md#ids-are-first-class](../principles.md#ids-are-first-class)) — `draft_id` is
  the handle for a later edit or delete.
- `cc` present only when `--cc` was passed; `thread_id` only when `--thread` was.
- `subject` falls back to `(no subject)` when empty.

The MIME structure is an implementation detail of the message, not of the response — the
output shape is unchanged by this spec.

### help[] suggestions

- The draft is saved and **NOT sent** — review and send it from the Gmail UI.
- Edit or delete it later via the `draft_id`.

## Errors

- `--to` empty or absent → `VALIDATION_ERROR` with a usage suggestion.
- `--body` and `--body-file` together → `VALIDATION_ERROR`.
- `--body-file` unreadable → `VALIDATION_ERROR` naming the path.
- Google failures via `translateGoogleError`
  ([principles.md#structured-errors-to-stdout](../principles.md#structured-errors-to-stdout)).

## Out of scope

- **Sending** — permanently, by design. See
  [principles.md#gmail-send-out-of-scope-by-design](../principles.md#gmail-send-out-of-scope-by-design).
- **Attachments** — a draft carries body text only; `multipart/mixed` with file parts is deferred.
- **A literal-text mode** — a future `--plain` would keep the `multipart/alternative` structure
  but build the HTML part structurally (escape, blank line → `<p>`, newline → `<br>`) instead of
  through markdown, for bodies whose `*`/`_`/`#` characters are meant literally. Not in v1; the
  markdown escape hatches (fenced code blocks, backslash escapes) cover the common case.
- **Inline images / `cid:` references** — deferred with attachments.

## Principles

**Inherited:**

- [gmail-send-out-of-scope-by-design](../principles.md#gmail-send-out-of-scope-by-design) — this
  command exists because sending doesn't; the human-in-the-loop send is what makes the draft's
  wire form final.
- [write-protection-requires-explicit-account](../principles.md#write-protection-requires-explicit-account)
  — `mutation: true`; explicit `--account` required with 2+ accounts.
- [ids-are-first-class](../principles.md#ids-are-first-class) — `draft_id` is the handle for the
  follow-up edit/delete.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — the response carries only
  what's needed to find and act on the new draft.

**Local:**

- **Composed output is wire-final.** When gws-axi composes content a human will send or forward
  without re-authoring it, the command is responsible for the representation that reaches the
  *recipient* — not merely for content that looks right in the intermediate UI. Choose the wire
  format whose rendering this tool controls, and never rely on the sending client to infer
  structure from unstructured text.

  > **Why:** The human's review step reads as a safety check, which makes it tempting to treat
  > anything the composer displays correctly as correct. It isn't: the composer shows the draft,
  > while the recipient sees whatever the send path produced from it. Single-part `text/plain`
  > was exactly this trap — correct in the compose window, mangled on arrival, with no signal in
  > between. Promote this to `principles.md` if a second composing surface (calendar invite
  > bodies, Docs/Slides content writes) needs the same rule.
