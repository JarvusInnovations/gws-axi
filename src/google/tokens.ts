import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import { credentialsPath, tokensPathForAccount } from "../config.js";

export interface StoredTokens {
  client_id: string;
  access_token: string;
  refresh_token?: string;
  expiry_date: number;
  scope: string;
  token_type: string;
  obtained_at: string;
}

interface InstalledCreds {
  client_id: string;
  client_secret: string;
}

interface CredentialsFile {
  installed?: InstalledCreds;
}

interface RefreshResponse {
  access_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Access token lifetime safety buffer — refresh 5 min before expiry. */
const EXPIRY_BUFFER_MS = 5 * 60_000;

export function readTokens(email: string): StoredTokens | null {
  const path = tokensPathForAccount(email);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as StoredTokens;
  } catch {
    return null;
  }
}

function writeTokens(email: string, tokens: StoredTokens): void {
  writeFileSync(
    tokensPathForAccount(email),
    `${JSON.stringify(tokens, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function readCredentials(): InstalledCreds {
  if (!existsSync(credentialsPath())) {
    throw new AxiError(
      "credentials.json missing — run `gws-axi auth setup`",
      "CREDENTIALS_MISSING",
      ["Run `gws-axi auth setup --credentials-json <path>`"],
    );
  }
  const parsed = JSON.parse(
    readFileSync(credentialsPath(), "utf-8"),
  ) as CredentialsFile;
  if (!parsed.installed?.client_id || !parsed.installed?.client_secret) {
    throw new AxiError(
      "credentials.json is not a Desktop OAuth client",
      "INVALID_CREDENTIALS",
      ["Re-run `gws-axi auth setup --credentials-json <path>` with a Desktop client JSON"],
    );
  }
  return parsed.installed;
}

function isExpired(tokens: StoredTokens): boolean {
  return tokens.expiry_date <= Date.now() + EXPIRY_BUFFER_MS;
}

/**
 * Force-refresh the access token using the stored refresh_token. Persists
 * the new access_token + expiry_date back to tokens.json (keeps the
 * existing refresh_token since Google doesn't rotate it on every refresh).
 */
export async function refreshAccessToken(email: string): Promise<StoredTokens> {
  const tokens = readTokens(email);
  if (!tokens) {
    throw new AxiError(
      `No stored tokens for ${email}`,
      "TOKENS_MISSING",
      [`Run \`gws-axi auth login --account ${email}\` to authenticate`],
    );
  }
  if (!tokens.refresh_token) {
    throw new AxiError(
      `No refresh token for ${email} — access token cannot be renewed`,
      "REFRESH_TOKEN_MISSING",
      [`Run \`gws-axi auth login --account ${email}\` to re-authenticate`],
    );
  }

  const creds = readCredentials();
  const body = new URLSearchParams({
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: tokens.refresh_token,
    grant_type: "refresh_token",
  });

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const txt = await res.text();
    // invalid_grant means the refresh token itself is revoked/expired
    if (res.status === 400 && txt.includes("invalid_grant")) {
      throw new AxiError(
        `Refresh token for ${email} has been revoked or expired (Testing-mode tokens expire after 7 days)`,
        "REFRESH_TOKEN_REVOKED",
        [`Run \`gws-axi auth login --account ${email}\` to re-authenticate`],
      );
    }
    throw new AxiError(
      `Token refresh failed (${res.status}): ${txt.slice(0, 200)}`,
      "REFRESH_FAILED",
      [`Run \`gws-axi auth login --account ${email}\` to re-authenticate`],
    );
  }

  const fresh = (await res.json()) as RefreshResponse;
  const updated: StoredTokens = {
    ...tokens,
    access_token: fresh.access_token,
    expiry_date: Date.now() + fresh.expires_in * 1000,
    scope: fresh.scope || tokens.scope,
    token_type: fresh.token_type,
  };
  writeTokens(email, updated);
  return updated;
}

/**
 * Return a valid access token for the account — auto-refreshing if the
 * stored one is expired or within EXPIRY_BUFFER_MS of expiry. Throws
 * AxiError if the account isn't authenticated or refresh fails.
 */
export async function getValidAccessToken(email: string): Promise<StoredTokens> {
  const tokens = readTokens(email);
  if (!tokens) {
    throw new AxiError(
      `No stored tokens for ${email}`,
      "TOKENS_MISSING",
      [`Run \`gws-axi auth login --account ${email}\` to authenticate`],
    );
  }
  if (!isExpired(tokens)) return tokens;
  return refreshAccessToken(email);
}
