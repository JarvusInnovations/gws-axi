# Command: gmail draft

## Summary

Composes a Gmail **draft** — the only outbound-mail verb gws-axi has. Sending is
withheld by design ([principles.md#gmail-send-out-of-scope-by-design](../principles.md#gmail-send-out-of-scope-by-design));
a human reviews the draft in the Gmail UI and presses send.

That division of labor is what makes the message's **on-the-wire form** load-bearing.
gws-axi authors the message; the human who sends it does not re-author it. So the draft
is built as a **single `text/html` part** carrying the `--body` markdown rendered to
HTML, and Gmail generates the `text/plain` alternative itself on send.

## Invocation

`gws-axi gmail draft --to <emails> --subject <text> --body <markdown> [flags]`

## Flags

- `--to <emails>` — REQUIRED. Comma-separated recipient addresses. Empty → `VALIDATION_ERROR`.
- `--subject <text>` — subject line. Default: empty (rendered as `(no subject)` in the response).
- `--body <markdown>` — the message body, as markdown unless `--plain` is passed (see
  [Body rendering](#body-rendering)).
- `--body-file <path>` — read the body from a file instead. Mutually exclusive with `--body`.
- `--cc <emails>` / `--bcc <emails>` — comma-separated.
- `--plain` — treat the body as **literal text** rather than markdown (see
  [Literal-text mode](#literal-text-mode)). Boolean; takes no value.
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
Content-Type: text/html; charset="UTF-8"
Content-Transfer-Encoding: base64

<the rendered HTML, base64, wrapped at 76 columns>
```

Rules:

- **The body is a single `text/html` part.** No `text/plain` alternative is sent; Gmail
  generates one on send (see below).
- **Base64** with CRLF line endings, wrapped at 76 columns (RFC 2045), so arbitrary UTF-8
  survives. The wrapping is transport-only and never appears in the decoded content.

### How Gmail's composer treats a draft

Gmail does **not** forward a stored draft byte-for-byte. Its composer adopts exactly *one*
part as its editing surface, discards the rest, and regenerates the delivered message from
the adopted part under its own boundary. Everything below is verified against live sends.

| Draft structure | Composer shows | Delivered result |
| --- | --- | --- |
| single `text/plain` | plain-text mode | **Broken.** Body hard-wrapped at ~70 columns with real CRLFs, no HTML alternative — ragged columns nothing can reflow |
| `multipart/alternative` (plain + HTML) | **either** — not predictable | **Coin flip.** Two identically-built drafts diverged: one kept the rendered markup, the other adopted the plain part and delivered the markdown source raw (`**bold**`, `[text](url)`) to the reader |
| single `text/html` | rich text | **Correct.** Markup preserved, and Gmail derives a proper `text/plain` alternative itself |

Two things follow, and an implementer must not get either wrong:

1. **Offer exactly one part, and make it the HTML.** The composer's choice is not under this
   command's control, so the only reliable way to control the outcome is to leave it nothing
   to choose between. Adding a `text/plain` alternative — even a well-formed one — reopens
   the coin flip for no gain, since Gmail synthesizes a better one than we can anyway.
2. **What fixes the wrapping is the presence of an HTML part, not its content.** Gmail's
   ~70–75 column hard wrap is applied to whichever part it *generates*; it only reaches the
   reader when a plain part is the only thing in the message. This is why the original defect
   was invisible in the compose window: the wrap happened at send, downstream of anything the
   author could see.

On send Gmail also normalizes the adopted HTML — wrapping the fragment in `<div dir="ltr">`,
adding `target="_blank"` to links, and sometimes tagging an edited paragraph with
`<span style="background-color:transparent">`. These are cosmetic and expected.

### Survives human editing

The structure holds through the composer, which is the whole point — a draft nobody edits is
the easy case. Verified: after a human typed into the middle of a paragraph, added a list
item, and appended new paragraphs, the delivered HTML still carried our `<p>`, `<strong>`,
`<a>`, `<br>`, and `<ul>`/`<li>`, with the human's additions merged into that structure (a
typed list item became an `<li>` inside our existing `<ul>`).

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

### Literal-text mode

`--plain` turns markdown interpretation off. It is for bodies where `*`, `_`, `#`, or
backticks must reach the reader as typed — pasted configuration, legal text, identifiers,
anything the author did not intend as markup.

It changes **how the body is interpreted, never the message structure**: the draft is still a
single `text/html` part. Sending `text/plain` — the obvious-looking implementation of a
"plain" flag — is the original defect this command's structure exists to avoid, and adding a
`text/plain` alternative alongside the HTML reopens the composer coin flip. Neither is
permitted.

The HTML is built structurally rather than through the markdown renderer:

- `&`, `<`, `>` are escaped, so markup in the body is displayed rather than rendered.
- **Block semantics match the markdown path** — a blank line starts a `<p>`, a single newline
  is a `<br>`. `--plain` should change what the characters *mean*, not where the text sits.
- **Indentation and column alignment are preserved.** HTML collapses runs of whitespace, which
  would destroy exactly the aligned text this mode exists to carry. Leading spaces become
  `&nbsp;`; an internal run keeps one real space — a wrap point, so the line still reflows —
  and pads the remainder. Tabs expand to four spaces first. This mirrors what Gmail itself does
  converting plain text to HTML, and is **verified end to end**: through a real send the
  entities arrive as literal U+00A0, and Gmail's own generated `text/plain` alternative turns
  them back into ordinary spaces with the alignment intact.
- Blocks that are entirely whitespace are dropped; an empty body yields an empty document.

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
