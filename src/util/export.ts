import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { ParsedArgs } from "./flags.js";

/**
 * The export-file contract (specs/api/conventions.md § Export files;
 * specs/principles.md#preview-to-stdout-full-data-to-a-file): a capped preview
 * on stdout, and on request the full payload in a file named by a per-format
 * flag. Implemented once here; commands decide what the payload is.
 */

export type ExportFormat = "json" | "csv";

/** The flags, by format. A command declares the ones it offers as `optional`. */
export const EXPORT_FLAGS: Record<ExportFormat, string> = {
  json: "--json-out",
  csv: "--csv-out",
};

export interface ExportRequest {
  format: ExportFormat;
  /** The flag as given, for messages. */
  flag: string;
  /** The `=<path>` value; undefined means an auto-generated path. */
  path?: string;
}

/** The export the invocation asked for, if any. Two `*-out` flags is a VALIDATION_ERROR. */
export function parseExportRequest(parsed: ParsedArgs): ExportRequest | undefined {
  const present = (Object.entries(EXPORT_FLAGS) as Array<[ExportFormat, string]>).filter(
    ([, flag]) => parsed.booleans.has(flag),
  );
  if (present.length === 0) return undefined;
  if (present.length > 1) {
    throw new AxiError(
      `Use one export flag per call, got ${present.map(([, f]) => f).join(" and ")}`,
      "VALIDATION_ERROR",
      ["Run the command once per format: the preview is the same both times"],
    );
  }
  const [format, flag] = present[0];
  return { format, flag, path: parsed.values[flag] };
}

/** `~/` expanded, relative paths against the working directory. */
export function expandPath(path: string): string {
  const expanded =
    path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/**
 * Where the file goes: the explicit path, or
 * `<os-temp-dir>/gws-axi/<UTC-timestamp>-<kind>.<ext>` — ephemeral scratch the
 * OS prunes.
 */
export function resolveExportPath(
  req: ExportRequest,
  kind: string,
  now: Date = new Date(),
): { path: string; auto: boolean } {
  if (req.path !== undefined) return { path: expandPath(req.path), auto: false };
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return { path: join(tmpdir(), "gws-axi", `${stamp}-${kind}.${req.format}`), auto: true };
}

/** POSIX-quote a path for a runnable help line, only when it needs it. */
function quotePath(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

export function exportHelpLine(format: ExportFormat, path: string): string {
  const p = quotePath(path);
  return format === "json"
    ? `Run \`jq '.rows[]' ${p}\` to process the full result (every row, uncapped)`
    : `Run \`head ${p}\` (or \`csvlook ${p}\`) to use the full result (every row, uncapped)`;
}

export type ExportOutcome =
  | {
      ok: true;
      path: string;
      /** `<path> (<rows> rows, <cols> cols)` — the `wrote:` line. */
      wrote: string;
      helpLine: string;
    }
  | {
      ok: false;
      path: string;
      /** The `export_error` block: the preview still renders, and the command exits 1. */
      error: { code: "EXPORT_WRITE_FAILED"; message: string; path: string };
      helpLine: string;
    };

/**
 * Write the payload. Auto paths get their directory created and the file
 * `0600` (the temp dir can be world-readable; results may be sensitive); an
 * explicit path is written as asked with the default umask, and a missing
 * parent there is EXPORT_WRITE_FAILED rather than a directory made silently.
 * Never throws: a failed write must not discard the result already fetched.
 */
export function writeExport(
  req: ExportRequest,
  kind: string,
  data: string,
  meta: { rows: number; cols: number },
  now?: Date,
): ExportOutcome {
  const { path, auto } = resolveExportPath(req, kind, now);
  try {
    if (auto) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      writeFileSync(path, data, { mode: 0o600 });
      chmodSync(path, 0o600);
    } else {
      writeFileSync(path, data);
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "its directory does not exist"
        : code === "EACCES"
          ? "permission denied"
          : code === "EISDIR"
            ? "that path is a directory"
            : (code ?? (err as Error).message);
    return {
      ok: false,
      path,
      error: {
        code: "EXPORT_WRITE_FAILED",
        message: `Could not write the ${req.flag} file: ${reason}`,
        path,
      },
      helpLine: auto
        ? `Nothing was written; pass a path you can write: ${req.flag}=<path>`
        : `Nothing was written; create the directory first, or pass ${req.flag} alone for a file in the temp dir`,
    };
  }
  return {
    ok: true,
    path,
    wrote: `${path} (${meta.rows} rows, ${meta.cols} cols)`,
    helpLine: exportHelpLine(req.format, path),
  };
}
