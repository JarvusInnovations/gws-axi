---
status: in-progress
depends: []
specs:
  - specs/commands/auth-login.md
issues: [69]
---

# Plan: served setup page and pasted-callback sign-in

## Scope

#69 plus the phone sign-in findings: serve the setup page from the callback server during
`--wait`; `auth login --callback-url`; a 30-minute prepared flow and a 9-minute wait; SSH-aware
instructions.

## Implements

- `specs/commands/auth-login.md`

## Approach

1. `loopback.ts`: constants for the windows; the callback server answers `GET /` with
   `setup.html`; the code-to-tokens tail of `awaitPendingAuth` becomes a shared `finishWithCode`
   used by both `--wait` and a new `completePendingAuthFromUrl`; a timeout returns
   `CALLBACK_TIMEOUT` without clearing the pending flow.
2. `auth.ts`: `--callback-url`; prepare output gains `page`; instructions and help name the
   page, the paste-back path, and (under SSH) `ssh -L`.

## Validation

- [ ] Unit: callback-URL validation (path, host, port, state, error param).
- [ ] Live: re-auth one account with `--callback-url` (the user approves; the agent pastes).
- [ ] Live: `--wait` serves the page at `http://127.0.0.1:<port>/` (curl it while waiting).
- [ ] build, lint, format:check, test.

## Risks / unknowns

- Live validation needs the user to approve a sign-in.

## Notes

_Populated at closeout._

## Follow-ups

_Populated at closeout._
