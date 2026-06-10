import { AxiError } from "axi-sdk-js";
import type { gmail_v1 } from "googleapis";
import { translateGoogleError } from "../../google/client.js";

/**
 * Fetch the full label inventory for an account. Shared by search and the
 * write commands so name→id resolution behaves identically everywhere.
 */
export async function fetchLabels(
  api: gmail_v1.Gmail,
  account: string,
): Promise<gmail_v1.Schema$Label[]> {
  try {
    const res = await api.users.labels.list({ userId: "me" });
    return res.data.labels ?? [];
  } catch (err) {
    throw translateGoogleError(err, {
      account,
      operation: "gmail.labels.list",
    });
  }
}

/**
 * Resolve a user-supplied label reference to a Gmail label ID. Accepts an
 * exact name (case-sensitive — Gmail labels are), a case-insensitive name,
 * or a raw label ID (system labels like INBOX/UNREAD, or Label_<n> ids).
 * Throws LABEL_NOT_FOUND with discovery suggestions when nothing matches.
 */
export function resolveLabelId(
  name: string,
  labels: gmail_v1.Schema$Label[],
): string {
  const exact = labels.find((l) => l.name === name);
  if (exact?.id) return exact.id;
  const insensitive = labels.find(
    (l) => l.name?.toLowerCase() === name.toLowerCase(),
  );
  if (insensitive?.id) return insensitive.id;
  const byId = labels.find((l) => l.id === name);
  if (byId?.id) return byId.id;
  throw new AxiError(`Label '${name}' not found`, "LABEL_NOT_FOUND", [
    `Run \`gws-axi gmail labels\` to see all available labels`,
    `Label names are case-sensitive; check for typos or extra whitespace`,
  ]);
}

/** Resolve a list of label references to IDs (see resolveLabelId). */
export function resolveLabelIds(
  names: string[],
  labels: gmail_v1.Schema$Label[],
): string[] {
  return names.map((n) => resolveLabelId(n, labels));
}

/** Map label IDs back to their user-facing names, falling back to the id. */
export function labelNamesFor(
  ids: string[],
  labels: gmail_v1.Schema$Label[],
): string[] {
  const byId = new Map<string, string>();
  for (const l of labels) {
    if (l.id) byId.set(l.id, l.name ?? l.id);
  }
  return ids.map((id) => byId.get(id) ?? id);
}

/**
 * Gmail's system labels are ALL_CAPS (INBOX, UNREAD, STARRED, …); user
 * labels use mixed case, nested slashes, or the Label_<n> id form. Matching
 * on all-caps catches any future system additions cheaply.
 */
export function isSystemLabel(id: string): boolean {
  return /^[A-Z_]+$/.test(id);
}
