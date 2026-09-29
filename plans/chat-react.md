---
status: done
depends: [chat-write]
specs:
  - specs/commands/chat-react.md
  - specs/commands/chat-read.md
---

# Plan: Chat reactions

## Scope

`chat react` and `chat unreact` for the account's own Unicode emoji reactions, and
`--fields reactions` on `chat messages` showing which emoji rather than a bare count.

**Out of scope:** custom emoji, shortcode aliases (`:thumbsup:`), listing who reacted.

## Implements

- `specs/commands/chat-react.md` — both commands.
- `specs/commands/chat-read.md` — the reactions column's new rendering.

## Approach

1. `src/commands/chat/react.ts`: shared flag parsing (space, message, `--emoji`); message id
   normalization, with `client-…` ids resolved through `messages.get`; emoji validation.
2. `react`: create; `409` → `already_reacted`; `400` invalid emoji → `INVALID_EMOJI`.
3. `unreact`: list the message's reactions filtered by emoji and the account's own user id
   (from the stored profile — `users/me` returns `500` in this filter), delete each; none →
   `not_reacted`.
4. Read the summary back with `messages.get` for the response.
5. Dispatcher entries with `mutation: true`; `reactions` column renders `👍 2 · 🎉 1`.
6. Tests: flag and id parsing, emoji validation, summary rendering, error mapping.

## Validation

- [x] `bun run build`, `lint`, `format:check`, `test` pass.
- [x] Live, in "Bot testing": react 👍 → `reacted`; again → `already_reacted`; via the
      `client-gws-axi-test-001` id → works; `unreact` → `unreacted`; again → `not_reacted`.
- [x] A skin-tone variant is a distinct reaction, and `unreact` of the plain emoji leaves it.
- [x] `--emoji :thumbsup:` and `--emoji hello` are refused before any call.
- [x] Without `--account` (2+ accounts) both return `ACCOUNT_REQUIRED`.
- [x] `chat messages --fields reactions` shows the emoji and counts.
- [x] No test reaction is left on any message afterwards.

## Risks / unknowns

- **Emoji validation is approximate.** The pre-check refuses shortcodes and plain ASCII; anything
  subtler is left to Chat, whose refusal maps to `INVALID_EMOJI`.

## Notes

- **Verified live in "Bot testing"** on gws-axi's own test message: react, repeat, react by
  `client-` id, a skin-tone variant alongside the plain emoji, then each removed; a second
  `unreact` was `not_reacted`. The message ended with no reactions.
- **Reading reactions was verified on a real conversation** (Pan-SLA Tech), read-only at the
  owner's direction: nothing was posted or reacted there.
- The API behavior the spec relies on was probed before the spec was written, so the spec
  records observations rather than assumptions.

## Follow-ups

- Tracked as: custom emoji and `:shortcode:` aliases.
