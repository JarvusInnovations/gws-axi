import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { URL } from "node:url";
import {
  credentialsPath,
  listAccounts,
  normalizeEmail,
  profilePathForAccount,
  readSetupState,
  setDefaultAccount,
  tokensPathForAccount,
} from "../config.js";
import { markStepDone } from "./state.js";
import { predictUnverifiedAppWarning } from "./health.js";
import { allScopes } from "./scopes.js";
import { editDistance } from "../util/typo.js";
import {
  clearPendingAuth,
  isPendingAuthExpired,
  readPendingAuth,
  writePendingAuth,
  type PendingAuth,
} from "./pending.js";
import { setupHtmlPath, writeSetupHtml } from "./setup-html.js";
import type { StepOutcome } from "./steps.js";

function collapseHome(path: string): string {
  const home = process.env.HOME ?? "";
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

interface InstalledCreds {
  client_id: string;
  client_secret: string;
}

interface CredentialsFile {
  installed?: InstalledCreds;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
  id_token?: string;
}

export interface StoredTokens {
  client_id: string;
  access_token: string;
  refresh_token?: string;
  expiry_date: number;
  scope: string;
  token_type: string;
  obtained_at: string;
}

export interface StoredProfile {
  email: string;
  verified_email: boolean;
  name?: string;
  picture?: string;
  sub: string;
  updated_at: string;
}

function readCredentials(): InstalledCreds | null {
  if (!existsSync(credentialsPath())) return null;
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(), "utf-8")) as CredentialsFile;
    return parsed.installed ?? null;
  } catch {
    return null;
  }
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function writeAccountFiles(email: string, tokens: StoredTokens, profile: StoredProfile): void {
  const tokensP = tokensPathForAccount(email);
  const profileP = profilePathForAccount(email);
  mkdirSync(dirname(tokensP), { recursive: true });
  writeFileSync(tokensP, `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(profileP, `${JSON.stringify(profile, null, 2)}\n`);
}

function buildAuthUrl(params: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  challenge: string;
  state: string;
  loginHint?: string;
}): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", params.clientId);
  u.searchParams.set("redirect_uri", params.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", params.scopes.join(" "));
  u.searchParams.set("code_challenge", params.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", params.state);
  u.searchParams.set("access_type", "offline");
  u.searchParams.set("prompt", "consent");
  // Deliberately NOT setting include_granted_scopes=true. That flag
  // returns access tokens covering every scope the user has ever
  // granted this OAuth client, not just the scopes we asked for now,
  // which makes scope counts balloon unpredictably when the user has
  // historical grants from testing / revocations / different scope
  // configs. Since we always request the full scope set and force
  // prompt=consent (so users re-approve every time), incremental
  // authorization isn't buying us anything — each auth should be a
  // clean grant matching exactly what we asked for.
  if (params.loginHint) {
    u.searchParams.set("login_hint", params.loginHint);
  }
  return u.toString();
}

async function exchangeCode(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  verifier: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: "authorization_code",
    code_verifier: params.verifier,
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${txt}`);
  }
  return (await res.json()) as TokenResponse;
}

interface UserInfo {
  sub: string;
  email: string;
  email_verified: boolean;
  name?: string;
  picture?: string;
}

async function fetchUserinfo(accessToken: string): Promise<UserInfo> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`userinfo failed (${res.status})`);
  }
  return (await res.json()) as UserInfo;
}

interface CallbackHandle {
  code: string;
  scope?: string;
  /**
   * Renders the final response to the browser. Hold the request open
   * during token-exchange + write so the page reflects the actual outcome
   * — sending a "success" page before we know the write succeeded was
   * misleading users into thinking re-auth had completed when it hadn't.
   */
  finalize: (result: { ok: true } | { ok: false; error: string }) => void;
}

interface CallbackExpectation {
  state: string;
  account?: string;
  joined: boolean;
}

/** Error thrown when Google returns an `error=` param on the callback. */
class OAuthCallbackError extends Error {
  constructor(public readonly oauthError: string) {
    super(`OAuth error: ${oauthError}`);
  }
}

async function waitForCallback(
  server: Server,
  expected: CallbackExpectation,
): Promise<CallbackHandle> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for OAuth callback after 5 minutes"));
    }, 5 * 60_000);

    server.on("request", (req: IncomingMessage, res: ServerResponse) => {
      if (!req.url) return;
      const u = new URL(req.url, "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const code = u.searchParams.get("code");
      const state = u.searchParams.get("state");
      const errorParam = u.searchParams.get("error");

      if (errorParam) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(
          errorParam === "access_denied"
            ? accessDeniedPage(expected.account, expected.joined)
            : errorPage(errorParam),
        );
        clearTimeout(timeout);
        reject(new OAuthCallbackError(errorParam));
        return;
      }
      if (!code || state !== expected.state) {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.end(errorPage("invalid_state_or_missing_code"));
        clearTimeout(timeout);
        reject(new Error("OAuth callback missing code or state mismatch"));
        return;
      }

      // Don't respond yet — hold the connection so the browser page can
      // reflect the actual exchange/write outcome. The caller calls
      // finalize() after attempting the rest of the flow.
      const finalize = (result: { ok: true } | { ok: false; error: string }): void => {
        res.statusCode = 200;
        res.setHeader("content-type", "text/html; charset=utf-8");
        if (result.ok) {
          res.end(successPage());
        } else {
          res.end(errorPage(result.error));
        }
      };

      clearTimeout(timeout);
      resolve({
        code,
        scope: u.searchParams.get("scope") ?? undefined,
        finalize,
      });
    });
  });
}

function successPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gws-axi — authenticated</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:24px;color:#222}h1{color:#1a7f37}</style>
</head><body><h1>Authenticated</h1><p>You can close this tab and return to your terminal.</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c);
}

function errorPage(message: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gws-axi — error</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:24px;color:#222}h1{color:#c62828}pre{background:#f4f4f4;padding:12px;border-radius:4px}</style>
</head><body><h1>Authentication failed</h1><pre>${escapeHtml(message)}</pre><p>Close this tab and check the terminal.</p></body></html>`;
}

/**
 * Did this install adopt a shared OAuth client via `auth join` (rather than a
 * from-scratch `auth setup`)? Joined teammates can't touch the shared project's
 * Cloud Console, so `access_denied` guidance must point them at the distributor.
 */
export function wasJoinedSetup(): boolean {
  try {
    const steps = readSetupState().steps;
    return Object.values(steps).some((s) => (s as { via?: unknown }).via === "team-join");
  } catch {
    return false;
  }
}

/**
 * Google returns `access_denied` most often because the user stopped at the
 * "Google hasn't verified this app" screen (clicking "Back to safety" instead
 * of Advanced → Go), and occasionally because of a Testing-mode test-user
 * gap or a Production user-cap limit. A joined teammate can't and shouldn't
 * touch the shared project's Cloud Console, so the guidance branches on
 * `joined` and never sends them there. Pure + unit-tested.
 */
export function accessDeniedCliInstructions(
  account: string | undefined,
  joined: boolean,
): string[] {
  const who = account ? `\`${account}\`` : "your Google account";
  const retry = `re-run \`gws-axi auth login --account ${account ?? "<email>"}\``;
  const lines = [
    `Google denied access. The most common cause is stopping at the "Google hasn't verified this app" screen — ${retry}, and this time click "Advanced" → "Go to <app> (unsafe)" (safe for an internal tool), then approve the scopes.`,
  ];
  if (joined) {
    lines.push(
      'You do NOT need Google Cloud Console or GCP project access. A Console "You need additional access" page is unrelated to signing in — ignore it and don\'t request project access.',
      `If it still fails after clicking through the warning, ask whoever shared this client — the fix is on their side (the consent screen's config or user cap), not yours.`,
    );
  } else {
    lines.push(
      `If it still fails, check your consent screen: in Testing, ${who} must be a test user (Audience → Test users); in Production, confirm the app hasn't hit its OAuth user cap.`,
    );
  }
  return lines;
}

function accessDeniedPage(account: string | undefined, joined: boolean): string {
  const retry = "retry <code>gws-axi auth login</code> in your terminal";
  const common = `<p>Google denied access. The most common cause is stopping at the <strong>"Google hasn't verified this app"</strong> screen — ${retry}, and this time click <strong>Advanced → Go to &lt;app&gt; (unsafe)</strong> (safe for an internal tool), then approve the scopes.</p>`;
  const tail = joined
    ? `<p>You don't need Google Cloud Console or GCP project access. A Console "You need additional access" page is unrelated to signing in — ignore it. If it still fails, ask whoever shared this client.</p>`
    : `<p>If it still fails, check your consent screen (test users in Testing, or the OAuth user cap in Production).</p>`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gws-axi — access denied</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:560px;margin:60px auto;padding:24px;color:#222;line-height:1.5}h1{color:#c62828}code{background:#f4f4f5;padding:2px 6px;border-radius:3px}</style>
</head><body><h1>Access denied</h1>${common}${tail}<p>Close this tab and return to your terminal.</p></body></html>`;
}

/**
 * Reserve a port by binding and immediately closing. The returned port is
 * likely still free when the caller uses it, but not guaranteed — there's
 * a microscopic race window. In practice it's not an issue.
 */
async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface PrepareOptions {
  expectedAccount?: string;
}

export interface PrepareOutcome {
  pending: PendingAuth;
  htmlPath: string;
  credentialsPresent: boolean;
}

/**
 * Phase 1: generate the auth URL, reserve a port, persist pending state,
 * write setup.html with the authenticate button. Returns immediately so the
 * agent can relay instructions to the user BEFORE any process blocks on a
 * callback. Call `awaitPendingAuth` after instructing the user.
 */
export async function preparePendingAuth(
  options: PrepareOptions = {},
): Promise<PrepareOutcome | { error: string; code: string }> {
  const creds = readCredentials();
  if (!creds) {
    return {
      error: "credentials.json missing — complete setup steps 1-4 first",
      code: "PRECONDITION_FAILED",
    };
  }

  // Clear any stale pending state from a previous abandoned run so the HTML
  // helper doesn't show two conflicting banners and so a future --wait
  // doesn't pick up the wrong pending.
  clearPendingAuth();

  const port = await reservePort();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const { verifier, challenge } = pkcePair();
  const state = base64url(randomBytes(16));
  const scopes = allScopes();
  const authUrl = buildAuthUrl({
    clientId: creds.client_id,
    redirectUri,
    scopes,
    challenge,
    state,
    loginHint: options.expectedAccount,
  });

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000); // 10 min — plenty for user + agent coordination
  const pending: PendingAuth = {
    version: 1,
    url: authUrl,
    port,
    verifier,
    state,
    expected_account: options.expectedAccount,
    started_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };
  writePendingAuth(pending);

  // Predict the unverified-app warning so the setup.html pending-auth
  // panel can surface it prominently — users miss the small "Advanced"
  // link and bail thinking the app is broken.
  const setupState = readSetupState();
  writeSetupHtml({
    pendingAuth: {
      url: authUrl,
      account: options.expectedAccount,
      warnings: {
        unverifiedApp: predictUnverifiedAppWarning(options.expectedAccount, !!setupState.published),
      },
    },
  });

  return {
    pending,
    htmlPath: setupHtmlPath(),
    credentialsPresent: true,
  };
}

/**
 * Phase 2: read pending state, start the callback server, block until the
 * user authenticates (or timeout). Runs the token exchange, fetches the
 * userinfo to identify the account, writes tokens + profile, updates
 * default account if first, regenerates setup.html without the banner.
 */
export async function awaitPendingAuth(): Promise<StepOutcome> {
  const step = "tokens_obtained" as const;

  const pending = readPendingAuth();
  if (!pending) {
    return {
      step,
      advanced: false,
      title: "No pending authentication",
      error: "No pending auth flow — run `gws-axi auth login --account <email>` first to prepare",
      code: "NO_PENDING_AUTH",
      instructions: [
        "Run `gws-axi auth login --account <email>` to prepare",
        "Then run `gws-axi auth login --wait` to block on the user's browser click",
      ],
    };
  }

  if (isPendingAuthExpired(pending)) {
    clearPendingAuth();
    return {
      step,
      advanced: false,
      title: "Pending authentication expired",
      error: "The prepared OAuth flow expired — prepare a new one",
      code: "PENDING_EXPIRED",
      instructions: ["Re-run `gws-axi auth login --account <email>` to prepare a fresh flow"],
    };
  }

  const creds = readCredentials();
  if (!creds) {
    return {
      step,
      advanced: false,
      title: "Credentials disappeared",
      error: "credentials.json is missing — was it deleted between prepare and wait?",
      code: "PRECONDITION_FAILED",
      instructions: ["Re-run `gws-axi auth setup --credentials-json <path>`"],
    };
  }

  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(pending.port, "127.0.0.1", () => resolve());
    });
  } catch (err) {
    return {
      step,
      advanced: false,
      title: "Could not bind callback server",
      error: `Port ${pending.port} is not available: ${err instanceof Error ? err.message : String(err)}`,
      code: "PORT_UNAVAILABLE",
      instructions: [
        "Another process is bound to that port. Retry with a fresh flow:",
        "Run `gws-axi auth login --account <email>` again",
      ],
    };
  }

  const redirectUri = `http://127.0.0.1:${pending.port}/callback`;

  // Snapshot account list BEFORE writing new tokens so we can detect
  // whether this is the first-ever account (should be promoted to
  // default) vs. an additional one (default stays put).
  const accountsBefore = listAccounts();

  const joined = wasJoinedSetup();

  let handle: CallbackHandle | undefined;
  try {
    handle = await waitForCallback(server, {
      state: pending.state,
      account: pending.expected_account,
      joined,
    });
    const tokens = await exchangeCode({
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      code: handle.code,
      redirectUri,
      verifier: pending.verifier,
    });
    const userinfo = await fetchUserinfo(tokens.access_token);

    const authenticatedEmail = normalizeEmail(userinfo.email);
    if (
      pending.expected_account &&
      normalizeEmail(pending.expected_account) !== authenticatedEmail
    ) {
      const expected = pending.expected_account;
      const distance = editDistance(expected, authenticatedEmail);
      const looksLikeTypo =
        distance <= 2 && Math.abs(expected.length - authenticatedEmail.length) <= 2;
      const browserMsg = looksLikeTypo
        ? `Likely typo in --account. You signed in as ${authenticatedEmail}, but --account was ${expected} (off by ${distance} character${distance === 1 ? "" : "s"}). Re-run \`gws-axi auth login --account ${authenticatedEmail}\` to use the account you signed in as.`
        : `Expected ${expected}, got ${authenticatedEmail}. Sign in as ${expected} and retry, or re-run with \`--account ${authenticatedEmail}\` if you meant the account you actually signed in as.`;
      handle.finalize({ ok: false, error: browserMsg });
      const cliInstructions = looksLikeTypo
        ? [
            `Looks like \`--account ${expected}\` had a typo (differs from the signed-in \`${authenticatedEmail}\` by ${distance} character${distance === 1 ? "" : "s"})`,
            `Re-run: \`gws-axi auth login --account ${authenticatedEmail}\``,
          ]
        : [
            `Re-run with: \`gws-axi auth login --account ${expected}\` and sign in as that account`,
            `Or, if you meant the account you actually signed in as: \`gws-axi auth login --account ${authenticatedEmail}\``,
          ];
      return {
        step,
        advanced: false,
        title: looksLikeTypo
          ? "Account mismatch — likely a typo in --account"
          : "Authenticated account does not match expected",
        error: `Expected ${expected}, got ${authenticatedEmail}`,
        code: "ACCOUNT_MISMATCH",
        instructions: cliInstructions,
      };
    }

    const grantedScopes = (handle.scope ?? tokens.scope).split(" ").filter(Boolean);
    const stored: StoredTokens = {
      client_id: creds.client_id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + tokens.expires_in * 1000,
      scope: grantedScopes.join(" "),
      token_type: tokens.token_type,
      obtained_at: new Date().toISOString(),
    };
    const profile: StoredProfile = {
      email: authenticatedEmail,
      verified_email: userinfo.email_verified,
      name: userinfo.name,
      picture: userinfo.picture,
      sub: userinfo.sub,
      updated_at: new Date().toISOString(),
    };
    writeAccountFiles(authenticatedEmail, stored, profile);

    // Only promote to default if there were no accounts BEFORE this one.
    // getDefaultAccount()'s implicit single-account fallback can return
    // undefined for a newly-added second account (no explicit default
    // in config.json because the first account was implicitly inferred
    // via listAccounts().length === 1), which would wrongly overwrite
    // the existing default. Always persist an explicit default_account
    // on first auth so subsequent auths don't disturb it.
    if (accountsBefore.length === 0) {
      setDefaultAccount(authenticatedEmail);
    }

    markStepDone(step, {
      accounts: listAccounts(),
      latest_account: authenticatedEmail,
    });

    // Token write succeeded — let the browser render the success page.
    handle.finalize({ ok: true });

    return {
      step,
      advanced: true,
      title: "Tokens obtained",
      detail: {
        account: authenticatedEmail,
        scopes_granted: grantedScopes.length,
        scopes_requested: allScopes().length,
        tokens_path: tokensPathForAccount(authenticatedEmail),
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // If the browser request is still open (waitForCallback succeeded but
    // a later step blew up), surface the error there too.
    handle?.finalize({ ok: false, error: message });

    // access_denied is the common "user bailed at the unverified-app warning"
    // case (and, less often, a test-user/user-cap gap). It gets its own code +
    // join-aware guidance that never sends a joined teammate to the Console —
    // distinct from a genuine flow error.
    if (err instanceof OAuthCallbackError && err.oauthError === "access_denied") {
      return {
        step,
        advanced: false,
        title: "Google denied access",
        error: message,
        code: "ACCESS_DENIED",
        instructions: accessDeniedCliInstructions(pending.expected_account, joined),
      };
    }

    return {
      step,
      advanced: false,
      title: "OAuth flow failed",
      error: message,
      code: "OAUTH_FAILED",
      instructions: [
        joined
          ? "This client was shared with you (`auth join`) — you don't need Cloud Console access; ask the distributor if it persists"
          : "Check that the consent screen (step 5) and test user (step 6) are configured",
        "Re-run: `gws-axi auth login --account <email>` to start a fresh flow",
      ],
    };
  } finally {
    // The browser holds a keep-alive connection to the callback server
    // after the success/error page renders. server.close() alone only
    // stops *new* connections — the lingering keep-alive keeps Node's
    // event loop alive indefinitely. closeAllConnections() forcibly
    // terminates them so the process exits immediately.
    server.closeAllConnections();
    server.close();
    clearPendingAuth();
    try {
      writeSetupHtml();
    } catch {
      // non-fatal
    }
  }
}

/**
 * Helper for callers (like `auth setup`) that want to expose the prepared
 * instructions to the user/agent as a StepOutcome. Does NOT block — just
 * wraps preparePendingAuth into the StepOutcome shape.
 */
export async function advanceTokensObtained(options: PrepareOptions = {}): Promise<StepOutcome> {
  const step = "tokens_obtained" as const;
  const prepared = await preparePendingAuth(options);
  if ("error" in prepared) {
    return {
      step,
      advanced: false,
      title:
        prepared.code === "PRECONDITION_FAILED"
          ? "OAuth credentials not yet saved"
          : "OAuth prepare failed",
      error: prepared.error,
      code: prepared.code,
      instructions: ["Re-run: `gws-axi auth setup --credentials-json <path>`"],
    };
  }
  const expected = prepared.pending.expected_account;
  return {
    step,
    advanced: false,
    title: "Step 7 of 7: Authenticate in your browser",
    instructions: [
      `The gws-axi setup page (${collapseHome(prepared.htmlPath)}) must be open in the browser PROFILE/SESSION where the user is signed into ${expected ? `\`${expected}\`` : "the target Google account"}. If initial setup ran in a different browser profile, tell the user to open ${collapseHome(prepared.htmlPath)} in the correct profile first.`,
      `In that setup page, the user waits for the yellow "Authenticate with Google" button (up to 10s auto-refresh), clicks it${expected ? `, signs in as \`${expected}\`` : ""}, approves scopes, and sees a success page.`,
      "After RELAYING these instructions to the user, IMMEDIATELY run `gws-axi auth login --wait` in a new bash turn — do NOT wait for the user to confirm they're ready. The callback server must be listening BEFORE the user clicks. If you delay, the click hits an unreachable localhost URL. The wait is harmless: it just listens for up to 5 min while the user takes their time.",
    ],
  };
}
