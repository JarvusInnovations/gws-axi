import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { AxiError } from "axi-sdk-js";

/**
 * Where a writer's content comes from: a local file, `-` for stdin, or
 * `--content <string>` — exactly one. Shared by `docs create|write|append` and
 * the `sheets` value writers so the rule and its errors are worded one way
 * (specs/principles.md#single-source-of-truth-helpers).
 */
export interface SourceFlags {
  localPath?: string;
  stdin: boolean;
  content?: string;
}

/** Split `-` (stdin) out of the positionals; the rest stay in order. */
export function takeStdin(positionals: string[]): { stdin: boolean; rest: string[] } {
  const rest: string[] = [];
  let stdin = false;
  for (const arg of positionals) {
    if (arg === "-") stdin = true;
    else rest.push(arg);
  }
  return { stdin, rest };
}

/**
 * The one-source rule. More than one source is always an error; none is one
 * unless `optional` (a create may start empty).
 */
export function checkOneSource(
  flags: SourceFlags,
  opts: { optional: boolean; what: string; usage: string },
): void {
  const sources =
    (flags.localPath ? 1 : 0) + (flags.stdin ? 1 : 0) + (flags.content !== undefined ? 1 : 0);
  if (sources > 1) {
    throw new AxiError("Provide exactly one content source", "VALIDATION_ERROR", [
      "A local path, `-` (stdin), and --content are mutually exclusive",
    ]);
  }
  if (sources === 0 && !opts.optional) {
    throw new AxiError("Missing content source", "VALIDATION_ERROR", [
      `Provide a local file path, \`-\` to read from stdin, or --content <${opts.what}>`,
      `Usage: ${opts.usage}`,
    ]);
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/** Read the chosen source; `undefined` when none was given. */
export async function readSource(flags: SourceFlags, what = "file"): Promise<string | undefined> {
  if (flags.content !== undefined) return flags.content;
  if (flags.stdin) return readStdin();
  if (!flags.localPath) return undefined;
  const absolutePath = resolve(process.cwd(), flags.localPath);
  let fileStat;
  try {
    fileStat = await stat(absolutePath);
  } catch {
    throw new AxiError(`Local file not found: ${flags.localPath}`, "LOCAL_FILE_NOT_FOUND", [
      "Check the path; it must be a readable file on this machine",
    ]);
  }
  if (fileStat.isDirectory()) {
    throw new AxiError(
      `Local path is a directory, not a file: ${flags.localPath}`,
      "LOCAL_PATH_NOT_FILE",
      [`Pass a single ${what}`],
    );
  }
  return readFile(absolutePath, "utf8");
}
