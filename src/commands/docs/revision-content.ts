import { AxiError } from "axi-sdk-js";
import type { drive_v3 } from "googleapis";
import {
  oauthClientForAccount,
  translateGoogleError,
} from "../../google/client.js";
import { sortRevisionsNewestFirst } from "../drive/revisions.js";

/**
 * Shared revision helpers used by `docs download --revision`, `docs read`
 * (recent-revisions block), and `docs diff`. Centralizing the
 * exportLinks-fetch + fallback logic keeps the three commands consistent and
 * avoids re-deriving the markdown-default behavior in each.
 */

export interface RecentRevision {
  id: string;
  modified: string;
  author: string;
}

/**
 * List the most recent `limit` revisions of a file, newest-first, with the
 * minimal `{id,modified,author}` shape. One page (pageSize 1000) is fetched
 * and sorted — Drive's revision count is effectively always well under that,
 * and this is a best-effort discovery aid, not the exhaustive listing that
 * `drive revisions` provides.
 */
export async function listRecentRevisions(
  api: drive_v3.Drive,
  fileId: string,
  limit: number,
): Promise<RecentRevision[]> {
  const res = await api.revisions.list({
    fileId,
    fields: "revisions(id,modifiedTime,lastModifyingUser(displayName))",
    pageSize: 1000,
  });
  const sorted = sortRevisionsNewestFirst(res.data.revisions ?? []);
  return sorted.slice(0, limit).map((r) => ({
    id: r.id ?? "",
    modified: r.modifiedTime ?? "",
    author: r.lastModifyingUser?.displayName ?? "",
  }));
}

export interface NativeRevisionExport {
  bytes: Buffer;
  /** The mime that was actually exported (may differ from the request on fallback). */
  mime: string;
  modified: string;
  author: string;
  /** Set when the requested default (markdown) was unavailable and we fell back. */
  note?: string;
}

/**
 * Export a native Google file's revision content via that revision's
 * `exportLinks` map. When `as` is omitted the default is `text/markdown` with a
 * fallback chain (`text/plain` → first available); an explicit `as` that isn't
 * available is an error, not a fallback. The chosen export URL is fetched with
 * the account's bearer token (exportLinks are arbitrary URLs, not a googleapis
 * method).
 *
 * Throws `REVISION_NOT_FOUND` (bad id), `EXPORT_FORMAT_REQUIRED` (format
 * unavailable), or `REVISION_CONTENT_UNAVAILABLE` (export GET failed).
 */
export async function fetchNativeRevisionExport(
  api: drive_v3.Drive,
  account: string,
  fileId: string,
  revisionId: string,
  as: string | undefined,
): Promise<NativeRevisionExport> {
  let revision: {
    modifiedTime?: string | null;
    exportLinks?: { [k: string]: string } | null;
    lastModifyingUser?: { displayName?: string | null } | null;
  };
  try {
    const res = await api.revisions.get({
      fileId,
      revisionId,
      fields: "id,modifiedTime,exportLinks,lastModifyingUser(displayName)",
    });
    revision = res.data;
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "drive.revisions.get",
    });
    if (translated.code === "NOT_FOUND") {
      throw new AxiError(
        `Revision '${revisionId}' not found on file '${fileId}'`,
        "REVISION_NOT_FOUND",
        [
          `List valid revisions with \`gws-axi drive revisions ${fileId}\``,
        ],
      );
    }
    throw translated;
  }

  const links = revision.exportLinks ?? {};
  const requested = as ?? "text/markdown";
  let chosen = requested;
  let url = links[requested];
  let note: string | undefined;
  // Fallback only applies to the default (markdown); an explicit --as that
  // isn't available is an error the caller must resolve.
  if (!url && !as) {
    const fallback = links["text/plain"] ?? Object.values(links)[0];
    const fallbackMime =
      Object.keys(links).find((k) => links[k] === fallback) ?? "";
    if (fallback) {
      chosen = fallbackMime;
      url = fallback;
      note = `text/markdown not available for this revision — exported as ${fallbackMime} instead`;
    }
  }
  if (!url) {
    throw new AxiError(
      `Export format ${requested} not available for revision ${revisionId}`,
      "EXPORT_FORMAT_REQUIRED",
      [
        `Available formats: ${Object.keys(links).join(", ") || "(none)"}`,
        "Pass a supported --as <mime>",
      ],
    );
  }

  const auth = await oauthClientForAccount(account);
  const { token } = await auth.getAccessToken();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new AxiError(
      `Failed to export revision ${revisionId} as ${chosen} (HTTP ${resp.status})`,
      "REVISION_CONTENT_UNAVAILABLE",
      [
        `List valid revisions with \`gws-axi drive revisions ${fileId}\``,
      ],
    );
  }
  return {
    bytes: Buffer.from(await resp.arrayBuffer()),
    mime: chosen,
    modified: revision.modifiedTime ?? "",
    author: revision.lastModifyingUser?.displayName ?? "",
    note,
  };
}
