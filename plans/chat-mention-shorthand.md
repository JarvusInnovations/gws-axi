---
status: done
depends: [chat-write]
specs:
  - specs/commands/chat-send.md
---

# Plan: `@email` mentions in chat send

## Scope

`@bob@example.com` in a `chat send` body becomes a real mention, and every mention — shorthand
or tag — is checked against the conversation's members before sending. At least one early,
prominent example demonstrates it: the first `chat send --help` example, the `chat --help`
examples, and the README.

**Out of scope:** `@name`, `@all`, mentioning people outside the conversation.

## Implements

- `specs/commands/chat-send.md` § Body — mentions, and `MENTION_NOT_MEMBER`.

## Approach

1. Pure `expandMentions(body)`: rewrite `@<email>` to the tag outside code spans and fences,
   honoring `\@` as a literal and requiring a boundary before `@`. Return the rewritten body
   plus every mentioned address and user id, from shorthand and tags alike.
2. In `chat send`, when the body mentions anyone, list the conversation's members and refuse
   before `messages.create` if any mention isn't one.
3. Examples and docs.
4. Tests for the rewriting rules, extraction, and the membership check.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Live in "Bot testing": `@chris@jarv.us` in a body stores a `USER_MENTION` and reads back
      as `@Chris Alfano`.
- [x] A mention of a nonexistent address is refused with `MENTION_NOT_MEMBER`, and nothing is
      posted.
- [x] A bare address and an address in inline code stay plain text.
- [x] The first `chat send --help` example, a `chat --help` example, and the README use it.

## Risks / unknowns

- **One extra call per send with mentions** (the member list). Sends without mentions are
  unchanged.

## Notes

- **Test messages in "Bot testing"** (only member: the account), which gws-axi cannot delete:
  - test 5 and test 6 — tag mentions by address and by id, verifying tags before this plan;
  - test 7 — a tag naming a nonexistent address, sent *before* the member check existed. It
    posted with the literal text `<chat-user>` in place of the mention. That observation is why
    the check exists;
  - test 8 — the shorthand, with a plain address and one in inline code beside it. One mention
    stored; the other two stayed text.
  Two sends refused by the new check posted nothing; the conversation's message count was
  verified before and after.
- **Early, prominent examples**: the first `chat send --help` example, the second
  `chat --help` example, and the first send line in the README all use `@bob@example.com`.

## Follow-ups

- Tracked as: what mentioning a real person outside the conversation does. Refused here rather
  than tested, since finding out means notifying or inviting someone.
