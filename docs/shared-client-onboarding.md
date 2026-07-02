# Shared-client onboarding (distributor runbook)

`gws-axi` is BYO-OAuth: there's no client embedded in the binary. But one Desktop
OAuth client legitimately serves a whole team — one person provisions it, and
teammates adopt it with `auth join`. This runbook is for the **distributor** (the
person who owns the GCP project + OAuth client). Teammates don't read this; they
just run two commands (see [Teammate steps](#teammate-steps)).

## The model

- One GCP project + one **Desktop** OAuth client, shared as a `credentials.json`.
- Teammates run `gws-axi auth join <path>` (adopts the client, marks setup steps
  1–6 done) then `gws-axi auth login --account <them>` (their own grant).
- **Teammates need zero GCP/Console access.** All project-side configuration is
  yours. gws-axi deliberately hides Console links from a joined install's
  `setup.html` — if a teammate ever lands on a Console "You need additional
  access" page, something pointed them wrong; they should ignore it and ping you.

## Consent screen: pick one configuration

The restricted `gmail.modify` scope drives the choice. Two workable setups:

### A) External + In Production (no test-user list)

- **User type: External**, **Publishing status: In production**.
- No test-user list exists in this mode — any Google account can authorize, up
  to the **OAuth user cap** (default 100) for unapproved sensitive/restricted
  scopes. The "N users / 100 user cap" figure is just how many accounts have
  authorized; it is not a list you curate, and you can't see individuals.
- Because the app isn't Google-verified, every teammate sees a **"Google hasn't
  verified this app"** screen and must click **Advanced → Go to \<app\> (unsafe)**.
  This is expected and safe for an internal tool; gws-axi warns about it up front.
- Watch the **user cap**: at ~100 distinct authorizing accounts you'd need
  verification (a CASA assessment for restricted scopes) to raise it.
- Refresh tokens are durable (Production, not the 7-day Testing expiry). Hand out
  the join command with `--published` so teammates' output reflects that.

### B) Internal (Workspace-only)

- **User type: Internal** — available only if every teammate is in your Google
  Workspace org (e.g. everyone on `@jarv.us`). No test users, no verification, no
  user cap, no unverified-app screen, durable tokens. The cleanest option **if**
  no outside-org accounts ever need it. External accounts can't use an Internal
  app at all.

> Avoid **External + Testing**: it caps at 100 *test users you must add by hand*
> and expires refresh tokens every 7 days. Only use it for a quick trial.

## Distribute

1. Download the Desktop OAuth client JSON from the Console.
2. Share it over a secure channel (vault, 1Password, etc.) — it contains the
   client secret. Don't commit it.
3. Hand teammates the exact command, baking in `--published` when the consent
   screen is In Production (A) or Internal (B):

   ```
   gws-axi auth join ~/Downloads/credentials.json --published
   gws-axi auth login --account you@jarv.us
   ```

## Teammate steps

Exactly two commands — no Console, no GCP project access:

```
gws-axi auth join <path-to-credentials.json>   # adopt the shared client
gws-axi auth login --account you@your-domain    # authenticate your account
```

At sign-in, click through the "Google hasn't verified this app" warning
(**Advanced → Go to \<app\>**). If `auth login` reports `ACCESS_DENIED`, it's
almost always because that warning was dismissed — retry and click through. If a
Google Cloud Console "You need additional access" page appears, **ignore it** and
ask the distributor; teammates never need project access.

See also: [`shared-client-future.md`](shared-client-future.md) (why BYO, and the
public-distribution decision) and the `auth join` spec
(`specs/commands/auth-join.md`).
