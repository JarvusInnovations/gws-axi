import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Strip path separators from an arbitrary name so it can be used as a
 * basename without risk of `../` escape or cross-directory writes.
 */
export function sanitizeFileName(name: string): string {
  return name.replace(/[/\\]/g, "_").trim() || "file";
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the final output path for a write operation.
 *
 *   - No `provided`: save to cwd with `baseName`
 *   - `provided` with trailing slash or an existing directory: join with `baseName`
 *   - Otherwise: use `provided` as the full file path
 */
export async function resolveOutputPath(
  provided: string | undefined,
  baseName: string,
): Promise<string> {
  const sanitized = sanitizeFileName(baseName);
  if (!provided) return resolve(process.cwd(), sanitized);
  const absolute = resolve(process.cwd(), provided);
  if (
    provided.endsWith("/") ||
    provided.endsWith("\\") ||
    (await isDirectory(absolute))
  ) {
    return join(absolute, sanitized);
  }
  return absolute;
}
