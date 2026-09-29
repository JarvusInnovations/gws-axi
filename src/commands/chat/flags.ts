import { AxiError } from "axi-sdk-js";

/**
 * Flag parsing shared by the chat subcommands.
 *
 * Each command declares the flags it takes; anything else is refused by name.
 * A dropped flag is worse than an error — the caller gets plausible output it
 * believes was filtered, and acts on it.
 */

export interface FlagSpec {
  /** Flags that take a value, e.g. `--limit`. */
  value?: string[];
  /** Flags that are present or absent, e.g. `--full`. */
  boolean?: string[];
}

export interface ParsedArgs {
  values: Record<string, string>;
  booleans: Set<string>;
  positionals: string[];
}

export function parseArgs(args: string[], spec: FlagSpec, command: string): ParsedArgs {
  const valueFlags = new Set(spec.value ?? []);
  const booleanFlags = new Set(spec.boolean ?? []);
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // A lone "-" is a positional (stdin), not a flag.
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (booleanFlags.has(arg)) {
      booleans.add(arg);
      continue;
    }
    if (valueFlags.has(arg)) {
      const next = args[i + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw new AxiError(`${arg} needs a value`, "VALIDATION_ERROR", [
          `Run \`gws-axi ${command} --help\` for usage`,
        ]);
      }
      values[arg] = next;
      i++;
      continue;
    }
    const valid = [...valueFlags, ...booleanFlags].sort();
    throw new AxiError(`Unknown flag ${arg} for \`${command}\``, "VALIDATION_ERROR", [
      `Valid flags for \`${command}\`: ${valid.join(", ")}, --account (--help always allowed)`,
    ]);
  }

  return { values, booleans, positionals };
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
