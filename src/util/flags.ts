import { AxiError } from "axi-sdk-js";

/**
 * Flag handling shared by every command (specs/principles.md#fail-loud-on-unknown-flags).
 *
 * Each command declares the flags it takes; anything else is refused by name,
 * before any network call, with the valid flags listed so one turn
 * self-corrects. A dropped flag is worse than an error — the caller gets
 * plausible output it believes was filtered, and acts on it.
 *
 * Newer commands parse with `parseArgs`. Older commands keep their own
 * parsers and are guarded by their dispatcher calling `checkFlags` with the
 * same declaration.
 */

export interface FlagSpec {
  /** Flags that take a value, e.g. `--limit`. */
  value?: string[];
  /** Flags that are present or absent, e.g. `--full`. */
  boolean?: string[];
  /**
   * Flags that may carry a value with `=` and only with `=`: `--csv-out` or
   * `--csv-out=./q4.csv` (specs/api/conventions.md § Export files). Presence is
   * recorded in `booleans`, the value (when given) in `values`. A following
   * token is never consumed.
   */
  optional?: string[];
  /** A targeted correction for a flag that doesn't exist but is a likely guess. */
  hints?: Record<string, string>;
  /** The command takes no `--account` (e.g. `doctor`), so errors don't offer it. */
  noAccount?: boolean;
}

export interface ParsedArgs {
  /** The last value given for each value flag. */
  values: Record<string, string>;
  /** Every value given for each value flag, in order — for repeatable flags. */
  lists: Record<string, string[]>;
  booleans: Set<string>;
  positionals: string[];
}

/** A token that reads as a flag name: `--clear`, `--txet` — not `---` or `-- note`. */
const FLAG_SHAPED = /^--[A-Za-z][A-Za-z0-9-]*$/;

export function parseArgs(args: string[], spec: FlagSpec, command: string): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const optionalFlags = new Set(spec.optional ?? []);
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // A lone "-" is a positional (stdin), not a flag.
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (booleanFlags.has(arg) || optionalFlags.has(arg)) {
      booleans.add(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (eq > 2) {
      const name = arg.slice(0, eq);
      if (optionalFlags.has(name)) {
        const value = arg.slice(eq + 1);
        if (value === "") {
          throw new AxiError(`${name}= needs a path after the =`, "VALIDATION_ERROR", [
            `Pass ${name} alone for an auto-generated path, or ${name}=<path>`,
            `Run \`gws-axi ${command} --help\` for usage`,
          ]);
        }
        booleans.add(name);
        values[name] = value;
        (lists[name] ??= []).push(value);
        continue;
      }
      // `--range=B2`: only optional-value flags take `=`, so the two forms are
      // never confused (specs/api/conventions.md § Export files).
      if (valueFlags.has(name) || booleanFlags.has(name)) {
        throw new AxiError(
          valueFlags.has(name)
            ? `${name} takes its value as the next argument, not with =: ${name} ${arg.slice(eq + 1)}`
            : `${name} takes no value`,
          "VALIDATION_ERROR",
          [`Run \`gws-axi ${command} --help\` for usage`],
        );
      }
    }
    if (valueFlags.has(arg)) {
      const next = args[i + 1];
      // Only a flag-shaped token is a missing value; `--- draft ---` is a value.
      if (next === undefined || FLAG_SHAPED.test(next)) {
        throw new AxiError(`${arg} needs a value`, "VALIDATION_ERROR", [
          `Run \`gws-axi ${command} --help\` for usage`,
        ]);
      }
      values[arg] = next;
      (lists[arg] ??= []).push(next);
      i++;
      continue;
    }
    const valid = [
      ...valueFlags,
      ...booleanFlags,
      ...[...optionalFlags].map((f) => `${f}[=<path>]`),
    ]
      .filter((f) => f !== "--account")
      .sort();
    const hint = spec.hints?.[arg];
    const always = spec.noAccount ? "(--help always allowed)" : "--account (--help always allowed)";
    throw new AxiError(`Unknown flag ${arg} for \`${command}\``, "VALIDATION_ERROR", [
      ...(hint ? [hint] : []),
      valid.length
        ? `Valid flags for \`${command}\`: ${[...valid, always].join(", ")}`
        : `\`${command}\` takes no flags ${spec.noAccount ? "" : "besides --account "}(--help always allowed)`,
      `Run \`gws-axi ${command} --help\` for usage`,
    ]);
  }

  return { values, lists, booleans, positionals };
}

/**
 * Validate flags without parsing them — for commands whose own parser predates
 * the shared one. Same errors as `parseArgs`.
 */
export function checkFlags(args: string[], spec: FlagSpec, command: string): void {
  parseArgs(args, spec, command);
}

/** A positive integer flag, clamped to `max`. */
export function parseLimit(
  raw: string | undefined,
  defaults: { fallback: number; max: number },
  command: string,
): number {
  if (raw === undefined) return defaults.fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new AxiError(`--limit expects a positive whole number, got: ${raw}`, "VALIDATION_ERROR", [
      `Run \`gws-axi ${command} --help\` for usage`,
    ]);
  }
  return Math.min(n, defaults.max);
}

/** One of a fixed set of values, reported by name when it isn't. */
export function parseChoice<T extends string>(
  flag: string,
  raw: string | undefined,
  choices: readonly T[],
): T | undefined {
  if (raw === undefined) return undefined;
  const value = raw.trim().toLowerCase() as T;
  if (!choices.includes(value)) {
    throw new AxiError(`Unknown ${flag} value: ${raw}`, "VALIDATION_ERROR", [
      `Valid values: ${choices.join(", ")}`,
    ]);
  }
  return value;
}

/**
 * A comma-separated `--fields`-style list, matched exactly (names like
 * `htmlLink` keep their case). An unknown name is an error — a dropped column
 * looks like an empty one.
 */
export function parseFieldList(flag: string, raw: string, choices: readonly string[]): string[] {
  const picked = raw
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const unknown = picked.filter((v) => !choices.includes(v));
  if (unknown.length) {
    throw new AxiError(
      `Unknown ${flag} value${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`,
      "VALIDATION_ERROR",
      [`Valid values: ${choices.join(", ")}`],
    );
  }
  return [...new Set(picked)];
}

/** A comma-separated list drawn from a fixed set. */
export function parseChoices<T extends string>(
  flag: string,
  raw: string | undefined,
  choices: readonly T[],
): T[] {
  if (raw === undefined) return [];
  const picked = raw
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean) as T[];
  for (const value of picked) {
    if (!choices.includes(value)) {
      throw new AxiError(`Unknown ${flag} value: ${value}`, "VALIDATION_ERROR", [
        `Valid values: ${choices.join(", ")}`,
      ]);
    }
  }
  return [...new Set(picked)];
}
