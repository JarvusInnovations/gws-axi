# Shared OAuth client — deferred

**Status:** Deferred. v1 ships with **bring-your-own OAuth client (BYO) only.**

## What was considered

Whether to embed a shared Google OAuth client ID in `gws-axi` so public users can run `npm install -g gws-axi` and authenticate without creating their own GCP project. This is how `gcloud` itself and many other first-party tools work.

## Why v1 is BYO-only

### 1. Gmail restricted scopes are expensive forever

Any shared client that requests `gmail.modify`, `gmail.readonly`, or full `https://mail.google.com/` requires Google's **CASA (Cloud Application Security Assessment)** — mandatory, annual, audited by a Google-approved lab.

- **Cost:** $1,500–$6,000/year for CASA Tier 2 (2026 lab rates); $8K–$25K+/year for Tier 3 if Workspace Marketplace listing or higher data volumes
- **Ongoing:** annual reassessment is mandatory. Miss it → client suspended
- **Gotcha:** `gmail.metadata` is *also* restricted. There is no "light Gmail" scope that avoids CASA for a general CLI tool

### 2. Sensitive-only shared client is viable but still meaningful overhead

A shared client limited to Calendar, Docs, Slides, and Drive-`drive.file` only requires OAuth Verification (no CASA). Still:

- Register LLC-owned domain (e.g. `gws-axi.dev`) for homepage + privacy policy
- Verify domain in Google Search Console
- Write and host privacy policy enumerating each scope
- Record brand-verification video showing end-to-end consent + each scope in use
- OAuth Verification submission: 2–8 weeks with typical 1–3 rejection rounds
- Ongoing: re-verification on new scopes / name / logo / homepage / entity changes

### 3. Suspension risk

Google's Trust & Safety can suspend an OAuth client for user abuse (spam, policy violations) with minimal warning. Suspension invalidates all refresh tokens instantly for every user. Recent public examples (OpenClaw, 2025) show appeals are opaque. A BYO model scopes the blast radius to the individual user.

### 4. Ship-first-verify-later

v1's goal is to replace our existing MCP servers and establish the `gws-axi` command surface. Shipping a dominant, well-designed CLI is the prerequisite to justifying any verification investment. We can add a shared-client mode later without breaking BYO users.

## What a shared-client future would look like

**Hybrid model** (not all-shared):

- **Shared client** (`JarvusInnovations/gws-axi` in GCP, Jarvus LLC-owned): Calendar, Docs, Slides, Drive-`drive.file` scopes. One-time verification, no ongoing audit fees.
- **BYO client permanent for Gmail**: users who want Gmail access set up their own OAuth client (same flow as v1 BYO). Positioned as privacy-preserving: "we don't want to audit your inbox."

Users choose mode at setup:

```bash
gws-axi auth setup --mode shared     # fast, no Gmail
gws-axi auth setup --mode byo        # full power, user creates GCP project
gws-axi auth setup --mode hybrid     # shared for most, BYO for Gmail
```

## Re-assessment triggers — when to revisit

Reconsider shipping the sensitive-scope shared client when **any** of:

- [ ] Setup friction is demonstrably the #1 user complaint (not speculation)
- [ ] A commercial path / enterprise use case justifies the one-time verification effort
- [ ] Jarvus owns a suitable public-facing domain for homepage + privacy policy
- [ ] Someone has capacity for the 1–3 month verification process (privacy policy, brand video, back-and-forth with Google)

**Do NOT revisit Gmail-included shared client unless** there is a clear ongoing revenue stream or strategic justification for $3K–$10K/year in perpetual CASA fees plus compliance overhead.

## If and when we do it — concrete steps

1. Incorporate Jarvus Innovations as verified owner in Google Cloud Console
2. Register domain, host static privacy policy page
3. Verify domain in Search Console
4. Create dedicated `gws-axi-prod` GCP project under Jarvus
5. Create OAuth consent screen (External, Production publishing status)
6. Create Desktop OAuth client
7. Record brand-verification video (scripted demo of each scope in use)
8. Submit OAuth Verification for sensitive scopes
9. Iterate on feedback from Google (typically 2–3 cycles)
10. Once verified, embed client ID in `gws-axi` as default for `--mode shared`
11. Document BYO as fallback/power-user mode
12. Monitor user adoption of each mode

## References

- [Google OAuth App Verification](https://support.google.com/cloud/answer/13463073)
- [Google CASA program](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
- [Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
