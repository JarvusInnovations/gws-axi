import { SERVICE_SCOPES, type ServiceName } from "../auth/scopes.js";
import { getValidAccessToken, type StoredTokens } from "./tokens.js";

export interface ProbeResult {
  service: ServiceName;
  status: "ok" | "warn" | "fail";
  detail: string;
}

interface ProbeContext {
  email: string;
  tokens: StoredTokens;
  accessToken: string;
}

function hasScope(tokens: StoredTokens, scope: string): boolean {
  const granted = tokens.scope.split(" ").filter(Boolean);
  return granted.includes(scope);
}

async function gfetch(
  url: string,
  accessToken: string,
): Promise<{ status: number; body: unknown; text?: string }> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 204) return { status: 204, body: null };
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: res.status, body, text };
}

function classifyError(
  service: ServiceName,
  status: number,
  body: unknown,
): ProbeResult {
  const err = (body as { error?: { message?: string; status?: string } } | null)
    ?.error;
  const message = err?.message ?? "";
  if (status === 401) {
    return {
      service,
      status: "fail",
      detail: `401 unauthorized — token revoked or invalid (${message})`,
    };
  }
  if (status === 403) {
    if (/scope|insufficient/i.test(message)) {
      return {
        service,
        status: "fail",
        detail: `403 insufficient_scope — ${service} scope not granted`,
      };
    }
    if (/disabled|not enabled/i.test(message)) {
      return {
        service,
        status: "fail",
        detail: `403 api_not_enabled — enable the ${service} API in the Console`,
      };
    }
    return { service, status: "fail", detail: `403 forbidden — ${message}` };
  }
  if (status === 429) {
    return { service, status: "warn", detail: `429 rate_limited — try again shortly` };
  }
  if (status >= 500) {
    return { service, status: "warn", detail: `${status} server_error — Google side` };
  }
  return {
    service,
    status: "fail",
    detail: `${status} ${message || "unexpected error"}`,
  };
}

async function probeGmail(ctx: ProbeContext): Promise<ProbeResult> {
  const service: ServiceName = "gmail";
  if (!hasScope(ctx.tokens, SERVICE_SCOPES.gmail)) {
    return { service, status: "fail", detail: "scope not granted" };
  }
  const { status, body } = await gfetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    ctx.accessToken,
  );
  if (status === 200) {
    const profile = body as {
      emailAddress?: string;
      messagesTotal?: number;
    };
    return {
      service,
      status: "ok",
      detail: `${profile.emailAddress ?? ctx.email}${profile.messagesTotal !== undefined ? ` · ${profile.messagesTotal} messages` : ""}`,
    };
  }
  return classifyError(service, status, body);
}

async function probeCalendar(ctx: ProbeContext): Promise<ProbeResult> {
  const service: ServiceName = "calendar";
  if (!hasScope(ctx.tokens, SERVICE_SCOPES.calendar)) {
    return { service, status: "fail", detail: "scope not granted" };
  }
  const { status, body } = await gfetch(
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&fields=items(id),nextPageToken",
    ctx.accessToken,
  );
  if (status === 200) {
    // API doesn't directly give a total count; do a second tiny call to count
    // all accessible calendars. Skip if the first call already showed none.
    const first = body as { items?: unknown[]; nextPageToken?: string };
    if (!first.items?.length) {
      return { service, status: "ok", detail: "0 calendars" };
    }
    // Second call to get full count cheaply — fields filter keeps payload tiny
    const { status: s2, body: b2 } = await gfetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?fields=items(id)",
      ctx.accessToken,
    );
    if (s2 === 200) {
      const count = ((b2 as { items?: unknown[] }).items ?? []).length;
      return { service, status: "ok", detail: `${count} calendars accessible` };
    }
    return { service, status: "ok", detail: "≥1 calendar (partial count)" };
  }
  return classifyError(service, status, body);
}

async function probeDrive(ctx: ProbeContext): Promise<ProbeResult> {
  const service: ServiceName = "drive";
  if (!hasScope(ctx.tokens, SERVICE_SCOPES.drive)) {
    return { service, status: "fail", detail: "scope not granted" };
  }
  const { status, body } = await gfetch(
    "https://www.googleapis.com/drive/v3/about?fields=user(emailAddress),storageQuota(usage,limit)",
    ctx.accessToken,
  );
  if (status === 200) {
    const about = body as {
      user?: { emailAddress?: string };
      storageQuota?: { usage?: string; limit?: string };
    };
    const email = about.user?.emailAddress ?? ctx.email;
    const usage = about.storageQuota?.usage
      ? `${Math.round(Number(about.storageQuota.usage) / 1_000_000)}MB used`
      : "";
    return {
      service,
      status: "ok",
      detail: usage ? `${email} · ${usage}` : email,
    };
  }
  return classifyError(service, status, body);
}

/**
 * Docs has no equivalent of drive.about — querying requires a known
 * document ID. Rely on scope presence + whether drive.about.get worked.
 * Caller should run probeDrive first and pass its status.
 */
function probeDocs(
  ctx: ProbeContext,
  driveOk: boolean,
): ProbeResult {
  const service: ServiceName = "docs";
  if (!hasScope(ctx.tokens, SERVICE_SCOPES.docs)) {
    return { service, status: "fail", detail: "scope not granted" };
  }
  if (!driveOk) {
    return {
      service,
      status: "warn",
      detail: "scope granted; drive probe failed so auth state unclear",
    };
  }
  return { service, status: "ok", detail: "scope granted (no cheap direct probe)" };
}

/**
 * Slides: same situation as docs — no cheap generic endpoint. Check scope
 * presence and rely on the drive probe as a proxy for auth health.
 */
function probeSlides(
  ctx: ProbeContext,
  driveOk: boolean,
): ProbeResult {
  const service: ServiceName = "slides";
  if (!hasScope(ctx.tokens, SERVICE_SCOPES.slides)) {
    return { service, status: "fail", detail: "scope not granted" };
  }
  if (!driveOk) {
    return {
      service,
      status: "warn",
      detail: "scope granted; drive probe failed so auth state unclear",
    };
  }
  return { service, status: "ok", detail: "scope granted (no cheap direct probe)" };
}

/**
 * Run all service probes for a single account in parallel (where they're
 * independent) and return results keyed by service name.
 */
export async function probeAccount(
  email: string,
): Promise<{ service: ServiceName; status: "ok" | "warn" | "fail"; detail: string }[]> {
  let tokens: StoredTokens;
  try {
    tokens = await getValidAccessToken(email);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // token refresh failed — every service fails for this account
    return (["gmail", "calendar", "docs", "drive", "slides"] as ServiceName[]).map(
      (service) => ({
        service,
        status: "fail" as const,
        detail: message,
      }),
    );
  }

  const ctx: ProbeContext = {
    email,
    tokens,
    accessToken: tokens.access_token,
  };

  // Gmail, Calendar, Drive are independent — run in parallel.
  const [gmail, calendar, drive] = await Promise.all([
    probeGmail(ctx).catch((e) => errorResult("gmail", e)),
    probeCalendar(ctx).catch((e) => errorResult("calendar", e)),
    probeDrive(ctx).catch((e) => errorResult("drive", e)),
  ]);

  const driveOk = drive.status === "ok";
  const docs = probeDocs(ctx, driveOk);
  const slides = probeSlides(ctx, driveOk);

  return [gmail, calendar, docs, drive, slides];
}

function errorResult(service: ServiceName, err: unknown): ProbeResult {
  return {
    service,
    status: "fail",
    detail: `probe error: ${err instanceof Error ? err.message : String(err)}`,
  };
}
