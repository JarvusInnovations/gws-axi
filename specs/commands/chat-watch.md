# Command group: chat wait and watch

## Summary

Lets an agent wait on Google Chat instead of polling it by hand.

- **`chat wait`** blocks until the first new message that matches, prints it, and exits. It is
  shaped for a background shell command: one completion, one answer.
- **`chat watch`** prints one line per new matching message, as it arrives, until stopped. It is
  shaped for a line-per-event monitor (Claude Code's Monitor tool, `tail`-style consumers): each
  line is one notification.

Both are reads. They never post, and they never change what is marked read.

## Precedent

`lavish-axi poll` blocks until feedback arrives, is meant to run in the background, and tells the
agent to simply re-run it if killed because nothing queued is lost. `gh-axi run watch` and
`chrome-devtools-axi wait <text>` block on a single outcome. `chat wait` follows these. `chat
watch` streams many events, which no existing AXI tool does; its rules below are new.

## Upstream behavior relied on

| Fact | Status |
| --- | --- |
| There is no push delivery for Chat messages under plain user OAuth; push needs the Workspace Events API plus a Pub/Sub topic on the Cloud project | Documented. Not used — polling instead |
| A conversation's `lastActiveTime` in `spaces.list` moves to the new message's `createTime` as soon as it is posted — for top-level messages and thread replies alike | **Observed 2026-09-30**: equal to the message's `createTime` at +0s, for both kinds |
| Timestamps carry microseconds, and `messages.list` with `createTime > "<exact createTime>"` returns exactly the messages after it | **Observed**: the message at that time was excluded and the next included |
| `messages.list` accepts only strict `>` / `<` on `createTime` | Observed earlier ([chat-read.md](chat-read.md)) |
| One `spaces.list` call returns every conversation with its `lastActiveTime` | Observed: 180 and 204 conversations in one page of 1000 |

## Invocation

```
gws-axi chat wait  (<space>… | --with <email> | --all) [filters] [--after <cursor>] [--timeout <dur>] [--interval <dur>] [--full]
gws-axi chat watch (<space>… | --with <email> | --all) [filters] [--after <cursor>] [--timeout <dur>] [--interval <dur>]
```

**What to watch** — exactly one of:

- one or more `<space>` ids or Chat URLs;
- `--with <email>` — the 1:1 direct message with that person;
- `--all` — every conversation the account is in, narrowed by `--type space|group|dm` if given.

**Filters** — a message must pass all of them to count:

- `--thread <id>` — only that thread. Requires exactly one `<space>`.
- `--from <email>` — only messages from that address.
- `--mentions-me` — only messages that mention the account.
- `--include-mine` — also the account's own messages. **Default: they are skipped**, so an agent
  that replies does not wake itself up.

**Timing:**

- `--after <cursor>` — start after this point. A cursor is printed by every run; any time the
  [range flags](../api/conventions.md#time-ranges) accept (`-1h`, `today`, an ISO time) also
  works. **Default: now** — nothing already posted is replayed.
- `--timeout <dur>` — give up after this long: `30s`, `9m`, `1h`, or `0` for no limit.
  **Default: `9m` for `wait`, `29m` for `watch`.**
- `--interval <dur>` — how often to check. **Default: `15s`, or `30s` with `--all`.** Minimum `5s`.

## How new messages are found

Every check is one `spaces.list` call. Its largest `lastActiveTime` is the **snapshot** — in
message-time terms, "now". A check then reads messages only from watched conversations whose
`lastActiveTime` moved past the previous snapshot, asking for `createTime` after it.

Messages are delivered for the window **(previous snapshot, current snapshot]** and nothing
later. One posted between the `spaces.list` call and the message read falls after the current
snapshot and is delivered by the next check. So each message is delivered **exactly once**,
across checks and across runs, with no dependence on the local clock.

- A quiet check costs one call, however many conversations are watched.
- Messages are delivered oldest first.
- The **cursor** is a snapshot timestamp exactly as Chat returns it, microseconds included. It is
  passed to Chat verbatim, never reparsed, so resuming neither skips nor repeats a message.

## `chat wait` output

On a match — the matching message, the cursor, and how to continue:

```
account: alice@example.com
matched: 1
space{id,type,name}: AAAAxyz,space,Transit Data
message{id,time,sender,thread,text}: Hk2.Hk2,2026-09-30T10:14:07-04:00,Bob Tran,t8Q,"the feed is back up"
cursor: "2026-09-30T14:14:07.255999Z"
help[2]:
  Reply: `gws-axi chat send AAAAxyz --thread t8Q --text "…" --account alice@example.com`
  Wait for the next one: `gws-axi chat wait AAAAxyz --after 2026-09-30T14:14:07.255999Z`
```

Several matches landing in one check are all printed as a `messages[N]` table, since dropping
all but one would lose them; `matched:` says how many. Text follows
[chat-read.md](chat-read.md#chat-messages): Markdown, mentions as `@Name`, 500 chars unless
`--full`.

On timeout — a definitive empty answer, exit 0:

```
account: alice@example.com
messages: none within 9m
cursor: "2026-09-30T14:23:07.100000Z"
help[1]:
  Keep waiting: `gws-axi chat wait AAAAxyz --after 2026-09-30T14:23:07.100000Z`
```

## `chat watch` output

Lines are written and flushed one at a time, each self-contained, because each becomes a
separate notification for a monitor:

```
watching: 2 conversations as alice@example.com, from 2026-09-30T14:10:00.000000Z, every 15s, stopping after 29m
2026-09-30T10:14:07-04:00 Transit Data · Bob Tran: the feed is back up [space=AAAAxyz msg=Hk2.Hk2 thread=t8Q cursor=2026-09-30T14:14:07.255999Z]
2026-09-30T10:15:31-04:00 Bob Tran (dm) · Bob Tran: also, @Alice Ng ⏎ see the log [space=BBBBabc msg=Qx9.Qx9 thread=Qx9 cursor=2026-09-30T14:15:31.018000Z]
stopped: timeout after 29m — resume: gws-axi chat watch AAAAxyz BBBBabc --after 2026-09-30T14:39:00.412000Z
```

- The **first line** confirms what is being watched, so an armed monitor is distinguishable from
  a dead one.
- A **message line** is local time, the conversation's name (derived as in `chat spaces` when it
  has none), the sender, the text on one line (line breaks as ` ⏎ `, cut at 300 chars), and the
  ids needed to act on it. Its `cursor` is that message's own `createTime`, so resuming from the
  last line seen repeats nothing.
- The **last line** says why it stopped and gives the exact resume command.

## Stopping

- **Stop before the harness does.** The default timeouts sit just under the limits of the tools
  that run these: 9 minutes under a 10-minute foreground-command ceiling, 29 minutes under a
  30-minute monitor ceiling. A command that stops itself prints its resume line; one that is
  killed may not.
- **And handle being killed anyway.** On `SIGTERM`, `SIGINT`, or `SIGHUP`, both print their
  resume line — `stopped: signal` for `watch`, the timeout block for `wait` — and exit 0.
- **Running out of time is an answer, not a failure**: exit 0.
- **Transient failures** — network errors, `429`, `5xx` — are retried at the next check. After
  three in a row, `watch` prints an `error:` line naming the failure and keeps trying, so a
  monitor surfaces the problem instead of staying silent; a later success prints `recovered:`.
- **Failures a retry cannot fix** — an invalid token, a missing scope, a conversation the account
  isn't in — stop the command with the structured error and exit 1. A dead watcher must never look
  like a quiet channel.

## Errors

| Code | When |
| --- | --- |
| `VALIDATION_ERROR` | No target, or more than one kind of target; `--thread` without exactly one `<space>`; `--type` without `--all`; a bad duration, interval below `5s`, or unparseable `--after` |
| `SPACE_NOT_FOUND`, `DM_NOT_FOUND`, `SCOPE_MISSING`, `TOKEN_INVALID` | As in [chat-read.md § Errors](chat-read.md#errors). Checked before the first wait, so a bad target fails immediately |

## Principles

**Inherited:**

- [read-only-stays-read-only](../principles.md#read-only-stays-read-only) — `mutation: false`;
  watching never marks anything read.
- [surface-completeness-limits](../principles.md#surface-completeness-limits) — polling means up
  to one interval of delay, stated in `--help`.
- [canonical-empty-list-shape](../principles.md#canonical-empty-list-shape) — a timed-out `wait`
  answers `messages: none within <dur>`.

**Local:**

- **A wait must be resumable without loss.** Every way a run can end — a match, a timeout, a
  signal — leaves a cursor that the next run can start from, and the delivery window makes a
  message fall on exactly one side of it.

  > **Why:** Agents run waits under harnesses that kill long commands, and they re-arm watches
  > many times over a session. If a restart can drop a message, an agent waiting for a reply can
  > miss the reply; if it can repeat one, an agent may answer twice. `lavish-axi poll` makes the
  > same promise for the same reason.
