---
status: done
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

- [x] Unit: callback-URL validation (path, host, port, state, error param).
- [x] Live: re-authed themightychris@gmail.com with `--callback-url` — the owner approved on a
      phone from the `auth_url` the SSH-aware prepare printed and pasted the failed page's
      address; 18 scopes granted, `directory.readonly` now present.
- [x] Live: `--wait` served the page at `http://127.0.0.1:<port>/` (title, Authenticate button,
      account); an unknown path 404s; stopping the wait left the prepared flow intact.
- [x] build, lint, format:check, test.

## Risks / unknowns

- Live validation needs the user to approve a sign-in.

## Notes

- Found while validating: a phone can't open the served page either, so the remote path
  needed Google's sign-in link itself. The prepare output adds `auth_url` only when
  `SSH_CONNECTION` is set; elsewhere the page remains the surface, as before.
- Google's redirect carried `iss` and `authuser` parameters beyond `state`/`code`/`scope`;
  validation ignores extras.

## Follow-ups

- Tracked as: admin@save-the-academy.org and savetheacademy1812@gmail.com still need re-auth
  for the Chat scopes and `directory.readonly` (the remaining doctor failures).
