---
status: done
depends: [chat-read]
specs:
  - specs/commands/chat-watch.md
---

# Plan: chat wait and chat watch

## Scope

`chat wait` (first match, then exit — for a background shell command) and `chat watch` (a line
per message until stopped — for a monitor), over named conversations, a DM by `--with`, or
`--all`, with thread, sender, mention, and own-message filters.

**Out of scope:** push delivery through the Workspace Events API; watching for edits,
deletions, or reactions.

## Implements

- `specs/commands/chat-watch.md` — both commands.

## Approach

1. **Poller** (`src/commands/chat/poller.ts`), pure over injected `listSpaces`, `listMessages`,
   `sleep`, and `now`, so every rule is unit-testable without Chat or a clock:
   - `check(prevSnapshot)` → one `spaces.list`; snapshot = max `lastActiveTime`; for watched
     spaces whose `lastActiveTime` > prev, list messages with `createTime > prev`, keep those
     `<= snapshot`, sort ascending.
   - Timestamps compared as microsecond integers, never as JS dates; cursors passed verbatim.
2. **Filters** applied after fetch: thread, sender address, mention of the account, own messages.
3. **Flags**: target exclusivity; `--after` accepting a cursor verbatim or a range-flag time;
   durations (`30s`, `9m`, `1h`, `0`); interval floor.
4. **`wait`**: loop until a check yields matches or the deadline passes; TOON output as specced.
5. **`watch`**: first line, message lines, `error:` / `recovered:` after three consecutive
   failures, final `stopped:` line. Lines written with `fs.writeSync(1, …)` so each is flushed
   and ordered.
6. **Signals**: SIGTERM/SIGINT/SIGHUP set a stop flag and interrupt the sleep; the run ends with
   its resume output, exit 0.
7. **Fatal errors** (auth, scope, unknown conversation) surface as structured errors, exit 1.
   The target is resolved before the first wait.
8. Dispatcher entries with `mutation: false`; help, README, project notes.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Unit: exactly-once delivery across consecutive checks and across a resume from a cursor,
      including a message that lands between the snapshot and the message read.
- [x] Unit: filters; own messages skipped by default; duration and cursor parsing.
- [x] Live, "Bot testing": `chat watch <space> --include-mine` under a monitor prints the
      first line, then one line per test message posted, each within one interval.
- [x] Live: `chat wait <space> --include-mine` in the background returns the message posted
      while it waits, with a cursor; `chat wait --after <that cursor>` does not return it again.
- [x] Live: `chat wait --timeout 20s` on a quiet conversation returns `messages: none within 20s`,
      exit 0, with a resume command.
- [x] Live: `chat watch --all --include-mine` picks up a message in "Bot testing".
- [x] Live: a thread reply is caught by `--thread`, and a top-level message is not.
- [x] Live: killing a `watch` with SIGTERM prints its resume line and exits 0.
- [x] Live: without `--include-mine`, the account's own test message is not reported.
- [x] A conversation the account isn't in fails before waiting, exit 1.
- [x] Nothing is posted anywhere but "Bot testing".

## Risks / unknowns

- **Up to one interval of latency** — inherent in polling; stated in help.
- **Server clock skew between conversations.** The snapshot relies on Chat's own timestamps being
  consistent across conversations; the local clock is never used for delivery.

## Notes

- **Probed before the spec was written**: `lastActiveTime` moves to the new message's
  `createTime` at +0s for top-level messages and thread replies alike, and
  `createTime > "<exact time>"` is exact to the microsecond. The delivery design rests on both.
- **Verified live under Claude Code's Monitor tool**: `chat watch` printed its first line, then
  tests 11–14 once each and in order, and ended itself on its 3-minute timeout with the resume
  line — before the Monitor's own deadline.
- **Verified live with background Bash**: a `--thread` wait ignored a top-level message and
  returned the reply; resuming from its cursor returned the next message and not that one; a
  default wait (no `--include-mine`) timed out past the account's own message; `--all` caught a
  post; SIGTERM ended both commands with their resume output, exit 0; an unknown conversation
  failed at once, exit 1.
- **Test messages, all in "Bot testing"**: tests 9 and 10 (the `lastActiveTime` probe, posted
  through the raw API), and tests 11–14.
- **Two concurrency surprises in testing were correct behavior**: a resume check that ran while
  another test posted returned that new post, not the old one.

## Follow-ups

- Tracked as: push delivery through the Workspace Events API and Pub/Sub, if polling latency
  ever matters.
- Tracked as: watching for edits, deletions, and reactions.
