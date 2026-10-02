# Command: auth login (the sign-in flow)

## Summary

How an account is signed in: gws-axi prepares an OAuth request (PKCE, loopback redirect to
`http://127.0.0.1:<port>/callback`), the user approves it in a browser, and gws-axi exchanges the
returned code for tokens. The flow is split so an agent can relay instructions before anything
blocks: `auth login --no-wait` prepares, `auth login --wait` listens.

This spec covers issue #69 and the remote/phone sign-in lessons recorded with it: the setup page
is **served** while gws-axi waits, and a sign-in whose browser can't reach this machine is
finished by **pasting the callback URL back**.

## Invocation

```
gws-axi auth login [--account <email>]                 # prepare + wait (humans)
gws-axi auth login [--account <email>] --no-wait       # prepare only (agents, turn 1)
gws-axi auth login --wait                              # wait for the prepared flow (agents, turn 2)
gws-axi auth login --callback-url '<url>'              # finish the prepared flow from a pasted URL
```

## Windows

- A prepared flow is valid for **30 minutes** (`expires_at` in the prepare output). Coordinating
  a sign-in with someone on a phone routinely took longer than the old 10.
- `--wait` listens for **9 minutes**, under the 10-minute ceiling of an agent's foreground shell,
  so it ends itself with a usable message instead of being killed. Running out of time does not
  expire the flow: re-running `--wait`, or `--callback-url`, still works until `expires_at`.

## The served setup page

While `--wait` (or the default blocking form) listens, the callback server also serves the setup
page at **`http://127.0.0.1:<port>/`** — the same page as `setup.html`, with the
"Authenticate with Google" button. One origin serves the page and receives the callback, so:

- the page and the callback are one URL to open, and clickable in a terminal, unlike a file path;
- an SSH user forwards **one** port (`ssh -L <port>:127.0.0.1:<port> <host>`) and the whole flow
  works from their laptop's browser;
- the server binds `127.0.0.1` only. Nothing is reachable from another machine.

The prepare output names the URL as `page` and says it is live only while gws-axi waits. The
file `setup.html` is still written and still works.

## Finishing from a pasted callback URL

When the browser that approves the sign-in cannot reach this machine — a phone, a laptop signed
into a remote devbox without a tunnel — Google still redirects it to
`http://127.0.0.1:<port>/callback?code=…&state=…`, which fails to load. That address is the
answer. `auth login --callback-url '<that url>'` finishes the prepared flow with it:

- The URL must be the prepared flow's redirect: path `/callback` on `127.0.0.1` (or
  `localhost`) at the prepared port, with the prepared `state`. Anything else is
  `CALLBACK_URL_MISMATCH` and nothing is exchanged.
- An `error=` URL (e.g. `access_denied`) is reported as the same error `--wait` reports.
- The code is single-use and bound to the PKCE verifier stored only on this machine, so a
  pasted URL is useless anywhere else.
- No server is bound; nothing needs to be listening when the user clicks.

The prepare output and the `--wait` timeout message both name this path. On a machine reached
over SSH (`SSH_CONNECTION` set), the prepare instructions lead with it and with the `ssh -L`
alternative, since the default — open the page on this machine — can't work there, and the
prepare output adds `auth_url`, Google's sign-in link, for the agent to hand to the user: a phone
can't open the served page, so the link has to travel some other way. It is printed only there,
since a terminal-wrapped jumbo URL is what the setup page exists to avoid.

## Errors

| Code | When |
| --- | --- |
| `NO_PENDING_AUTH` | `--wait` / `--callback-url` with nothing prepared |
| `PENDING_EXPIRED` | The prepared flow is past `expires_at` |
| `CALLBACK_URL_MISMATCH` | The pasted URL isn't this flow's redirect (path, host, port, or state) |
| `CALLBACK_TIMEOUT` | `--wait` heard nothing in 9 minutes; the flow is still valid, and the suggestions give `--wait` again and `--callback-url` |
| `ACCOUNT_MISMATCH`, `ACCESS_DENIED`, `OAUTH_FAILED` | As before |

## Principles

- [never-auto-launch-browsers](../principles.md#never-auto-launch-browsers) — gws-axi serves the
  page; the user opens it in the browser profile they choose.
- [structured-errors-to-stdout](../principles.md#structured-errors-to-stdout) — a timeout is a
  structured, recoverable answer, not a dead process.

**Local:**

- **The address bar is a valid channel.** A sign-in must be finishable from wherever the user
  approved it. When the redirect can't reach gws-axi, the user carrying the URL back is the
  supported path, not a workaround.
