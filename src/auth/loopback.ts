import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { dirname } from "node:path";
import { URL } from "node:url";
import {
  credentialsPath,
  listAccounts,
  normalizeEmail,
  profilePathForAccount,
  setDefaultAccount,
  tokensPathForAccount,
  getDefaultAccount,
} from "../config.js";
import { markStepDone } from "./state.js";
import { allScopes } from "./scopes.js";
import { setupHtmlPath, writeSetupHtml } from "./setup-html.js";
import type { StepOutcome } from "./steps.js";

function collapseHome(path: string): string {
  // minimal local helper; avoids circular-ish imports from commands/*
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
  return input
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function writeAccountFiles(
  email: string,
  tokens: StoredTokens,
  profile: StoredProfile,
): void {
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
  u.searchParams.set("include_granted_scopes", "true");
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

async function waitForCallback(
  server: Server,
  expectedState: string,
): Promise<{ code: string; scope?: string }> {
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

      res.statusCode = 200;
      res.setHeader("content-type", "text/html; charset=utf-8");

      if (errorParam) {
        res.end(errorPage(errorParam));
        clearTimeout(timeout);
        reject(new Error(`OAuth error: ${errorParam}`));
        return;
      }
      if (!code || state !== expectedState) {
        res.end(errorPage("invalid_state_or_missing_code"));
        clearTimeout(timeout);
        reject(new Error("OAuth callback missing code or state mismatch"));
        return;
      }

      res.end(successPage());
      clearTimeout(timeout);
      resolve({ code, scope: u.searchParams.get("scope") ?? undefined });
    });
  });
}

function successPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gws-axi — authenticated</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:24px;color:#222}h1{color:#1a7f37}</style>
</head><body><h1>Authenticated</h1><p>You can close this tab and return to your terminal.</p></body></html>`;
}

function errorPage(message: string): string {
  const escaped = message.replace(/[<>&]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c] ?? c,
  );
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>gws-axi — error</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:24px;color:#222}h1{color:#c62828}pre{background:#f4f4f4;padding:12px;border-radius:4px}</style>
</head><body><h1>Authentication failed</h1><pre>${escaped}</pre><p>Close this tab and check the terminal.</p></body></html>`;
}

export interface LoopbackOptions {
  expectedAccount?: string;
}

export async function advanceTokensObtained(
  options: LoopbackOptions = {},
): Promise<StepOutcome> {
  const step = "tokens_obtained" as const;
  const creds = readCredentials();
  if (!creds) {
    return {
      step,
      advanced: false,
      title: "OAuth credentials not yet saved",
      error: "credentials.json missing — step 4 must complete first",
      code: "PRECONDITION_FAILED",
      instructions: ["Re-run: `gws-axi auth setup --credentials-json <path>`"],
    };
  }

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
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

  // Surface the auth URL on setup.html (clickable button) instead of
  // printing it to the terminal OR launching the browser ourselves. OS-
  // level `open` picks whatever browser the system considers default,
  // which is often NOT the browser session the user signed into Google
  // with (wrong profile, agent's debug browser, etc.). setup.html is
  // already in the user's chosen browser — clicks there stay in session.
  writeSetupHtml({
    pendingAuth: { url: authUrl, account: options.expectedAccount },
  });

  const htmlPath = collapseHome(setupHtmlPath());
  process.stderr.write(
    `Waiting for authentication${options.expectedAccount ? ` as ${options.expectedAccount}` : ""}.\nSwitch to your gws-axi setup page (${htmlPath}) and click "Authenticate with Google".\nIf it's not open, open it manually in the browser where you're signed into the target Google account.\nTimeout: 5 minutes.\n`,
  );

  try {
    const { code, scope } = await waitForCallback(server, state);
    const tokens = await exchangeCode({
      clientId: creds.client_id,
      clientSecret: creds.client_secret,
      code,
      redirectUri,
      verifier,
    });
    const userinfo = await fetchUserinfo(tokens.access_token);

    const authenticatedEmail = normalizeEmail(userinfo.email);
    if (
      options.expectedAccount &&
      normalizeEmail(options.expectedAccount) !== authenticatedEmail
    ) {
      return {
        step,
        advanced: false,
        title: "Authenticated account does not match expected",
        error: `Expected ${options.expectedAccount}, got ${authenticatedEmail}`,
        code: "ACCOUNT_MISMATCH",
        instructions: [
          `Re-run with: \`gws-axi auth login --account ${options.expectedAccount}\``,
          "Make sure you sign in as the correct account in the browser",
        ],
      };
    }

    const grantedScopes = (scope ?? tokens.scope).split(" ").filter(Boolean);
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

    // First account → auto-set as default
    if (!getDefaultAccount()) {
      setDefaultAccount(authenticatedEmail);
    }

    // Mark step 7 done globally (applies to "at least one account authenticated")
    markStepDone(step, {
      accounts: listAccounts(),
      latest_account: authenticatedEmail,
    });

    return {
      step,
      advanced: true,
      title: "Tokens obtained",
      detail: {
        account: authenticatedEmail,
        scopes_granted: grantedScopes.length,
        scopes_requested: scopes.length,
        tokens_path: tokensPathForAccount(authenticatedEmail),
      },
    };
  } catch (err) {
    return {
      step,
      advanced: false,
      title: "OAuth flow failed",
      error: err instanceof Error ? err.message : String(err),
      code: "OAUTH_FAILED",
      instructions: [
        "Check that the consent screen (step 5) and test user (step 6) are configured",
        "Re-run: `gws-axi auth login`",
      ],
    };
  } finally {
    server.close();
    // Clear the pending-auth banner whether we succeeded, failed, or timed
    // out so the setup page doesn't keep offering a now-dead button.
    try {
      writeSetupHtml();
    } catch {
      // non-fatal — setup.html regen is cosmetic
    }
  }
}
