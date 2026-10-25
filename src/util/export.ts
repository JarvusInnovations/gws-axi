import { existsSync, lstatSync, mkdirSync, statSync, writeFileSync } from "node:fs";
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
 * The auto-export directory: per-user (`gws-axi-<uid>`) so a shared temp dir
 * never hands us someone else's directory by name; `gws-axi` where there is
 * no uid (Windows).
 */
export function autoExportDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return join(tmpdir(), uid === undefined ? "gws-axi" : `gws-axi-${uid}`);
}

/**
 * Where the file goes: the explicit path, or
 * `<os-temp-dir>/gws-axi-<uid>/<UTC-timestamp>-<kind>.<ext>` — ephemeral
 * scratch the OS prunes.
 */
export function resolveExportPath(
  req: ExportRequest,
  kind: string,
  now: Date = new Date(),
): { path: string; auto: boolean } {
  if (req.path !== undefined) return { path: expandPath(req.path), auto: false };
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return { path: join(autoExportDir(), `${stamp}-${kind}.${req.format}`), auto: true };
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

class UnsafeDir extends Error {}

/**
 * Make (or accept) the auto directory only when it is ours alone: a real
 * directory, not a symlink, owned by this uid, no group/other bits. `mkdir`'s
 * mode does nothing to a directory that already exists, so it is checked.
 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!st.isDirectory()) throw new UnsafeDir(`${dir} is not a directory (a symlink?)`);
  if (uid === undefined) return; // Windows: no POSIX owner/mode to check
  if (st.uid !== uid) throw new UnsafeDir(`${dir} belongs to another user`);
  if ((st.mode & 0o077) !== 0) {
    throw new UnsafeDir(
      `${dir} is readable or writable by others (mode ${(st.mode & 0o777).toString(8)})`,
    );
  }
}

/** Create the file exclusively (never through an existing file or symlink), suffixing on a collision. */
function writeExclusive(path: string, data: string): string {
  const dot = path.lastIndexOf(".");
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? path : `${path.slice(0, dot)}-${n}${path.slice(dot)}`;
    try {
      writeFileSync(candidate, data, { mode: 0o600, flag: "wx" });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new UnsafeDir(`no free name beside ${path}`);
}

function failure(req: ExportRequest, path: string, reason: string, auto: boolean): ExportOutcome {
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

/** An export that failed before anything could be written (e.g. the upstream CSV fetch). */
export function exportFailed(req: ExportRequest, kind: string, reason: string): ExportOutcome {
  const { path, auto } = resolveExportPath(req, kind);
  return failure(req, path, reason, auto);
}

/**
 * Write the payload. Auto paths go in the per-user directory, checked private,
 * created exclusively at `0600`; an explicit path is written as asked with the
 * default umask (replacing a file there, disclosed as `overwrote`), and a
 * missing parent is EXPORT_WRITE_FAILED rather than a directory made silently.
 * Never throws: a failed write must not discard the result already fetched.
 */
export function writeExport(
  req: ExportRequest,
  kind: string,
  data: string,
  meta: { rows: number; cols: number },
  now?: Date,
): ExportOutcome {
  const resolved = resolveExportPath(req, kind, now);
  const { auto } = resolved;
  let path = resolved.path;
  let overwrote = false;
  try {
    if (auto) {
      ensurePrivateDir(dirname(path));
      path = writeExclusive(path, data);
    } else {
      overwrote = existsSync(path) && statSync(path).isFile();
      writeFileSync(path, data);
    }
  } catch (err) {
    if (err instanceof UnsafeDir) return failure(req, path, `refused: ${err.message}`, auto);
    const code = (err as NodeJS.ErrnoException).code;
    const reason =
      code === "ENOENT"
        ? "its directory does not exist"
        : code === "EACCES"
          ? "permission denied"
          : code === "EISDIR"
            ? "that path is a directory"
            : (code ?? (err as Error).message);
    return failure(req, path, reason, auto);
  }
  return {
    ok: true,
    path,
    wrote: `${path} (${meta.rows} rows, ${meta.cols} cols${overwrote ? ", overwrote" : ""})`,
    helpLine: exportHelpLine(req.format, path),
  };
}
