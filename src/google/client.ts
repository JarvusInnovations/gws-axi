import { AxiError } from "axi-sdk-js";
import {
  google,
  type calendar_v3,
  type docs_v1,
  type drive_v3,
  type gmail_v1,
  type sheets_v4,
  type slides_v1,
} from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { isJoinedInstall, readSetupState } from "../config.js";
import { getValidAccessToken } from "./tokens.js";

/**
 * Build an OAuth2Client seeded with the stored tokens for `email`. Uses
 * google-auth-library's refresh mechanism via the refresh_token so the
 * client auto-refreshes mid-request if the access token hits 401. We also
 * set expiry_date so the library proactively refreshes before 401s.
 */
export async function oauthClientForAccount(email: string): Promise<OAuth2Client> {
  const tokens = await getValidAccessToken(email);
  const auth = new OAuth2Client();
  auth.setCredentials({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date,
    scope: tokens.scope,
    token_type: tokens.token_type,
  });
  return auth;
}

export async function calendarClient(email: string): Promise<calendar_v3.Calendar> {
  const auth = await oauthClientForAccount(email);
  return google.calendar({ version: "v3", auth });
}

export async function gmailClient(email: string): Promise<gmail_v1.Gmail> {
  const auth = await oauthClientForAccount(email);
  return google.gmail({ version: "v1", auth });
}

export async function docsClient(email: string): Promise<docs_v1.Docs> {
  const auth = await oauthClientForAccount(email);
  return google.docs({ version: "v1", auth });
}

export async function driveClient(email: string): Promise<drive_v3.Drive> {
  const auth = await oauthClientForAccount(email);
  return google.drive({ version: "v3", auth });
}

export async function slidesClient(email: string): Promise<slides_v1.Slides> {
  const auth = await oauthClientForAccount(email);
  return google.slides({ version: "v1", auth });
}

export async function sheetsClient(email: string): Promise<sheets_v4.Sheets> {
  const auth = await oauthClientForAccount(email);
  return google.sheets({ version: "v4", auth });
}

interface GoogleApiErrorShape {
  code?: number;
  message?: string;
  errors?: Array<{ reason?: string; message?: string; domain?: string }>;
  response?: {
    status?: number;
    data?: {
      error?: {
        code?: number;
        message?: string;
        errors?: Array<{ reason?: string; message?: string }>;
        status?: string;
      };
    };
  };
}

interface ExtractedError {
  code: number;
  message: string;
  reason: string | undefined;
  status: string | undefined;
}

function extractError(err: unknown): ExtractedError {
  const e = err as GoogleApiErrorShape;
  const apiError = e.response?.data?.error;
  const code = apiError?.code ?? e.code ?? e.response?.status ?? 0;
  const message =
    apiError?.message ?? e.message ?? (err instanceof Error ? err.message : String(err));
  const reason = apiError?.errors?.[0]?.reason ?? e.errors?.[0]?.reason;
  const status = apiError?.status;
  return { code, message, reason, status };
}

/**
 * Who can fix a disabled API depends on who owns the project. An owned install
 * re-runs `auth setup`, which re-enables anything a release added. A joined
 * teammate has no access to the shared project, so they're pointed at the
 * distributor — never at `auth setup` or the Cloud Console.
 */
function apiNotEnabledSuggestions(operation: string): string[] {
  let joined = false;
  try {
    joined = isJoinedInstall(readSetupState());
  } catch {
    // Unreadable setup state: fall through to the owned-install advice.
  }
  if (joined) {
    return [
      `Ask whoever distributed your gws-axi credentials to enable the API behind ${operation} on the shared project`,
      "You don't need Google Cloud Console access — this is a project-side setting only they can change",
    ];
  }
  return [
    "Run `gws-axi auth setup` — it enables any API this project is missing and leaves your accounts signed in",
  ];
}

/**
 * Translate a Google API error into an AxiError with actionable suggestions.
 * Caller context (account, operation name) improves the suggestions.
 */
export function translateGoogleError(
  err: unknown,
  context: { account: string; operation: string },
): AxiError {
  const { code, message, reason, status } = extractError(err);
  const { account, operation } = context;

  if (code === 401 || status === "UNAUTHENTICATED") {
    const suggestions = [
      `Run \`gws-axi auth login --account ${account}\` and complete the OAuth flow in the browser (the command blocks for up to 5 min waiting on the callback)`,
    ];
    if (!readSetupState().published) {
      // The 7-day Testing-state expiry is the most common cause; nudge the
      // user toward publishing so they don't re-hit this every week.
      suggestions.push(
        "Tokens issued by OAuth apps in 'Testing' state expire after 7 days — run `gws-axi auth publish` to walk through publishing your consent screen to Production (eliminates the recurring re-auth)",
      );
    }
    return new AxiError(
      `Authentication failed for ${account} — token revoked or expired`,
      "TOKEN_INVALID",
      suggestions,
    );
  }

  if (code === 403 || status === "PERMISSION_DENIED") {
    // Key on Google's reason, or on wording that says the scope is
    // insufficient. A message that merely mentions "scope" isn't a scope
    // failure, and re-auth advice can't fix whatever it actually is.
    if (
      reason === "insufficientPermissions" ||
      reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" ||
      /insufficient[\w\s]*\bscopes?\b/i.test(message)
    ) {
      return new AxiError(
        `Insufficient scope for ${operation} — this account needs to re-consent`,
        "SCOPE_MISSING",
        [`Run \`gws-axi auth login --account ${account}\` to re-consent to the full scope set`],
      );
    }
    if (
      reason === "accessNotConfigured" ||
      /has not been used|not enabled|API is disabled/i.test(message)
    ) {
      return new AxiError(
        `API not enabled in the GCP project backing this OAuth client`,
        "API_NOT_ENABLED",
        apiNotEnabledSuggestions(operation),
      );
    }
    return new AxiError(`Forbidden: ${message}`, "FORBIDDEN", reason ? [`Reason: ${reason}`] : []);
  }

  if (code === 404 || status === "NOT_FOUND") {
    return new AxiError(message || "not found", "NOT_FOUND", []);
  }

  if (code === 400 && (reason === "failedPrecondition" || status === "FAILED_PRECONDITION")) {
    return new AxiError(
      message || "Operation not supported for this resource",
      "OPERATION_NOT_SUPPORTED",
      reason ? [`Reason: ${reason}`] : [],
    );
  }

  if (code === 429 || status === "RESOURCE_EXHAUSTED") {
    return new AxiError(`Rate limit exceeded for ${operation}`, "RATE_LIMITED", [
      "Retry after a short wait",
    ]);
  }

  if (code >= 500) {
    return new AxiError(
      `Google server error (${code}) on ${operation}: ${message}`,
      "SERVER_ERROR",
      ["Retry after a moment"],
    );
  }

  return new AxiError(
    message || `Unknown error on ${operation}`,
    code ? `GOOGLE_API_ERROR_${code}` : "UNKNOWN_ERROR",
    reason ? [`Reason: ${reason}`] : [],
  );
}

/**
 * Convenience wrapper: run a Google API call for `email` and translate any
 * thrown error. Callers pass the operation name (e.g. "calendar.events.list")
 * so error messages are specific.
 */
export async function runGoogleApi<T>(
  email: string,
  operation: string,
  fn: (auth: OAuth2Client) => Promise<T>,
): Promise<T> {
  const auth = await oauthClientForAccount(email);
  try {
    return await fn(auth);
  } catch (err) {
    throw translateGoogleError(err, { account: email, operation });
  }
}

/**
 * Retry a function that may hit Gmail/Drive rate limits. Naive fixed
 * backoff: wait 1s, 2s, then 4s before giving up. Only retries on
 * RATE_LIMITED (HTTP 429) — 5xx and other transient errors aren't
 * retried here because the right behavior varies per operation.
 *
 * Errors from `fn` are expected to be raw Google API errors (not yet
 * translated). Final errors are always returned translated so callers
 * can handle them uniformly.
 */
export async function withRateLimitRetry<T>(
  context: { account: string; operation: string },
  fn: () => Promise<T>,
): Promise<T> {
  const delays = [1000, 2000, 4000];
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const translated = translateGoogleError(err, context);
      if (translated.code !== "RATE_LIMITED" || attempt === delays.length) {
        throw translated;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
  // Unreachable: loop either returns or throws.
  throw new Error("withRateLimitRetry: exhausted retries without throw");
}
