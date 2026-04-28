import { readSetupState } from "../config.js";
import { readTokens, type StoredTokens } from "../google/tokens.js";
import { SERVICE_SCOPES } from "./scopes.js";

export type Permanence =
  | "permanent" // published, token issued after publish
  | "testing-7-day" // not yet published (Testing-state policy applies)
  | "pre-publish-7-day"; // published, but this token was issued before publish

export interface AccountHealth {
  email: string;
  obtained_at: string;
  permanence: Permanence;
  permanence_detail: string;
}

/**
 * Compare an account's token-issuance timestamp against the publish
 * timestamp in setup state to classify token permanence. Returns null when
 * the account has no stored tokens.
 */
export function summarizeAccountHealth(email: string): AccountHealth | null {
  const tokens = readTokens(email);
  if (!tokens) return null;
  const state = readSetupState();
  const obtainedMs = new Date(tokens.obtained_at).getTime();

  if (!state.published) {
    return {
      email,
      obtained_at: tokens.obtained_at,
      permanence: "testing-7-day",
      permanence_detail:
        "consent screen still in Testing — token expires after 7 days; run `auth publish` to lift the expiry",
    };
  }

  const publishedMs = new Date(state.published.confirmed_at).getTime();
  if (obtainedMs >= publishedMs) {
    return {
      email,
      obtained_at: tokens.obtained_at,
      permanence: "permanent",
      permanence_detail: `permanent — issued ${formatDelta(obtainedMs - publishedMs)} after publish`,
    };
  }

  return {
    email,
    obtained_at: tokens.obtained_at,
    permanence: "pre-publish-7-day",
    permanence_detail: `7-day clock — issued ${formatDelta(publishedMs - obtainedMs)} before publish; re-auth (\`gws-axi auth login --account ${email}\`) to upgrade`,
  };
}

function formatDelta(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export interface RestrictedScopeProbe {
  ok: boolean;
  detail: string;
}

/**
 * Probe the user's most-restricted scope to verify the unverified-app
 * Restricted-scope access is actually working at the API level. We use
 * Gmail's `users/me/profile` endpoint because it requires `gmail.modify`
 * (a Restricted scope per Google's classification). A 200 here is the
 * positive signal that "your tokens work for the most-stringent scope
 * Google checks." Skipped (returned ok with a note) if the gmail scope
 * wasn't granted to begin with.
 */
export async function probeRestrictedScope(
  tokens: StoredTokens,
): Promise<RestrictedScopeProbe> {
  const granted = tokens.scope.split(" ").filter(Boolean);
  if (!granted.includes(SERVICE_SCOPES.gmail)) {
    return {
      ok: true,
      detail: "skipped — gmail scope not granted (no restricted scope to verify)",
    };
  }
  try {
    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile",
      { headers: { authorization: `Bearer ${tokens.access_token}` } },
    );
    if (res.status === 200) {
      return {
        ok: true,
        detail: "gmail.modify ✓ (verified via users/me/profile)",
      };
    }
    const text = await res.text();
    return {
      ok: false,
      detail: `${res.status} — ${text.slice(0, 120)}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `network error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
