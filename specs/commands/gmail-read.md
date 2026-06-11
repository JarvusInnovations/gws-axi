# Command: gmail read

## Summary

Reads a Gmail thread (or single message) and renders it for agent consumption. This spec covers the existing thread/message rendering **and** the raw-headers mode added for message provenance inspection.

## Invocation

`gws-axi gmail read <id> [flags]`

- `<id>` — a thread ID or message ID (both 16-char hex, indistinguishable by shape). Default resolution: try `threads.get` first, fall back to `messages.get` → parent thread.

## Flags

- `--message-only` — render only the message with the given ID, not its parent thread. ID must be a message ID in this mode.
- `--full` — bypass the ~30,000-char size threshold; render every message body in full inline.
- `--out <path>` — write the full thread (or message) to a markdown file instead of inline (implies `--full`).
- `--headers` — render the message's full RFC 2822 header set as structured output, alongside the normal parsed body. Surfaces provenance headers the default parsed view omits (full `Received:` chain, `Message-ID`, `In-Reply-To`, `References`, `Date`, and authentication results: `DKIM-Signature`/`Authentication-Results`/`ARC-Authentication-Results` when present). Also surfaces the server-assigned `internalDate`.
- `--raw` — emit the message exactly as Gmail returns it in `format=raw`: the complete, undecoded RFC 2822 source (all headers + MIME body) as a single text block, base64url-decoded to UTF-8. For piping to a parser or saving verbatim.
- `--account <email>` — account override when 2+ are configured.

`--raw` and `--headers` operate on a single message. When given a thread ID, they resolve to the thread's most recent message and note that resolution in `help[]`. Combined with `--message-only`, they act on exactly the given message ID. `--raw` and `--headers` are mutually exclusive with each other; if both are passed, `VALIDATION_ERROR`.

## Data Requirements

- Default + `--headers`: Gmail `users.messages.get` / `users.threads.get` with `format=full` (already used). `--headers` additionally reads `payload.headers[]` (full list, not just the parsed subset) and the message's `internalDate`.
- `--raw`: Gmail `users.messages.get` with `format=raw`, which returns `raw` — the base64url-encoded full RFC 2822 message. Decode to a UTF-8 string for output.
- All covered by the existing `gmail.modify` scope. No new scope.

## Display Rules

- **Default / `--full` / `--out` / `--message-only`**: unchanged from current behavior — `thread{...}` header + `messages[N]` with parsed from/to/date/subject/body/attachments, size-threshold truncation, markdown-conversation file output.
- **`--headers`**: in addition to the `account:` header, emit:
  - a `message{id,thread_id,internal_date}` header object;
  - a `headers[N]{name,value}` list of every RFC 2822 header on the message, in the order Gmail returns them, values untruncated ([principles.md#ids-are-first-class](../principles.md#ids-are-first-class) applies to `Message-ID` and the IDs);
  - the normal parsed `message{...from,to,date,subject,body...}` block, so the agent gets both the provenance headers and the readable body in one call ([feedback: complete-context defaults]).
- **`--raw`**: emit the `account:` header, a `message{id,thread_id,internal_date,bytes}` header, then the decoded RFC 2822 source under a single `raw:` text field. No body parsing, no truncation by the size threshold (the point is fidelity); `--out` may be combined with `--raw` to write the source to a file instead of inline.

## Actions

Read-only. Honors [principles.md#read-only-stays-read-only](../principles.md#read-only-stays-read-only) — no label or state mutation as a side effect (does not mark read).

## Errors

- Unknown ID → `THREAD_NOT_FOUND` / `MESSAGE_NOT_FOUND` (as today) with search suggestion.
- `--raw` + `--headers` together → `VALIDATION_ERROR`.
- Google errors via `translateGoogleError`.

## Principles

**Inherited:**

- [ids-are-first-class](../principles.md#ids-are-first-class) — `Message-ID`, `In-Reply-To`, `References` are the cross-message linkage an agent follows; surface them untruncated.
- [minimal-default-schemas](../principles.md#minimal-default-schemas) — full headers and raw source are opt-in behind `--headers`/`--raw`; the default stays the lean parsed view.
- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — reading never marks the message read or otherwise mutates it.
