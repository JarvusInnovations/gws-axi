import { AxiError } from "axi-sdk-js";
import { translateGoogleError } from "./client.js";
import { getValidAccessToken } from "./tokens.js";

/**
 * The Visualization Query endpoint (`/spreadsheets/d/<id>/gviz/tq`) — not a
 * Google API client, so it lives beside client.ts rather than in it. Spec:
 * specs/commands/sheets-query.md (Data Requirements, Upstream behavior).
 *
 * Observed 2026-10-25: a bearer token for the `spreadsheets` scope (or `drive`)
 * is accepted; a refused request is an HTML page with 401/403/404, never a
 * JSON error; an unknown `gid` silently reads the first sheet, so callers must
 * resolve the tab themselves and pass a gid they know exists.
 */

/** The wrapper's function name, fixed so the body can be unwrapped by name. */
export const RESPONSE_HANDLER = "gwsAxi";

export interface GvizColumn {
  id: string;
  label: string;
  type: string;
  pattern?: string;
}

/** A cell: `null`, `{v: null}`, or a raw `v` with an optional formatted `f`. */
export type GvizCell = { v?: unknown; f?: string | null } | null;

export interface GvizRow {
  c: GvizCell[];
}

export interface GvizTable {
  cols: GvizColumn[];
  rows: GvizRow[];
}

export interface GvizIssue {
  reason?: string;
  message?: string;
  detailed_message?: string;
}

export interface GvizResponse {
  status: "ok" | "warning" | "error";
  table?: GvizTable;
  errors?: GvizIssue[];
  warnings?: GvizIssue[];
}

export interface GvizRequest {
  spreadsheetId: string;
  gid: number;
  query: string;
  /** Header rows; undefined leaves Google's own detection. */
  headers?: number;
}

export function gvizUrl(req: GvizRequest, out: "json" | "csv"): string {
  const params = new URLSearchParams({ tq: req.query, gid: String(req.gid) });
  if (req.headers !== undefined) params.set("headers", String(req.headers));
  params.set("tqx", out === "json" ? `out:json;responseHandler:${RESPONSE_HANDLER}` : "out:csv");
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(req.spreadsheetId)}/gviz/tq?${params}`;
}

/**
 * The JSON object inside `/*O_o*\/\ngwsAxi({…});`. Located by the handler
 * name, else by the first `{` and last `}`; a body that yields no object fails
 * loud with its head, so a changed wrapper is diagnosable.
 */
export function unwrapGviz(body: string): GvizResponse {
  const named = body.indexOf(`${RESPONSE_HANDLER}(`);
  const start = named >= 0 ? body.indexOf("{", named) : body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(body.slice(start, end + 1)) as GvizResponse;
      if (parsed && typeof parsed === "object" && typeof parsed.status === "string") return parsed;
    } catch {
      // fall through to the loud failure
    }
  }
  throw new AxiError(
    `Unexpected response from the query endpoint: ${JSON.stringify(body.slice(0, 160))}`,
    "UNEXPECTED_RESPONSE",
    ["The endpoint's response format may have changed; report this with the line above"],
  );
}

/** A CSV body that is really the JSON error object (observed: HTTP 200, `text/csv`). */
export function csvError(body: string): GvizResponse | undefined {
  const head = body.trimStart();
  if (!head.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(head) as GvizResponse;
    return parsed?.status === "error" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function send(account: string, url: string, operation: string): Promise<string> {
  const { access_token } = await getValidAccessToken(account);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${access_token}` },
      redirect: "manual",
    });
  } catch (err) {
    throw translateGoogleError(err, { account, operation });
  }
  if (res.status === 401 || res.status === 403) {
    throw new AxiError(
      `The query endpoint refused ${account}'s token (HTTP ${res.status})`,
      "ACCESS_DENIED",
      [
        `Confirm ${account} can open the spreadsheet (view access is enough)`,
        `Run \`gws-axi auth login --account ${account}\` if the account's sign-in has lapsed`,
      ],
    );
  }
  if (res.status >= 300) {
    throw translateGoogleError(
      { code: res.status, message: `HTTP ${res.status} from the query endpoint` },
      { account, operation },
    );
  }
  return res.text();
}

/** Run the query; the parsed response (an `error` status is returned, not thrown). */
export async function runGvizQuery(account: string, req: GvizRequest): Promise<GvizResponse> {
  return unwrapGviz(await send(account, gvizUrl(req, "json"), "sheets gviz/tq"));
}

/** Google's own CSV of the same query; an error status comes back as the parsed error. */
export async function fetchGvizCsv(
  account: string,
  req: GvizRequest,
): Promise<{ csv: string } | { error: GvizResponse }> {
  const body = await send(account, gvizUrl(req, "csv"), "sheets gviz/tq (csv)");
  const error = csvError(body);
  return error ? { error } : { csv: body };
}
