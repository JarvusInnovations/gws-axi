/**
 * Signposts for scaffolded subcommands.
 *
 * A stub that refuses with nothing but "not implemented; see --help" — where
 * `--help` lists the same unimplemented command — is a closed circuit, and an
 * agent's way out of a closed circuit is to leave gws-axi entirely and drive
 * the Google APIs with the raw token, discarding write-protection and error
 * translation with it. So every stub declares the working commands that do
 * some or all of its job, and the same list feeds all three surfaces a caller
 * can hit: the NOT_IMPLEMENTED error, the stub's own --help, and the service
 * help screen.
 *
 * See specs/principles.md#no-dead-end-surfaces and specs/api/conventions.md
 * ("Unimplemented and unsupported surfaces").
 */

import { AxiError } from "axi-sdk-js";

export interface StubbableSubcommand {
  name: string;
  handler?: unknown;
  /**
   * Runnable gws-axi commands that accomplish some or all of this subcommand's
   * job. Each line names the command AND where it falls short — these are
   * mostly wholesale-replace substitutes for a granular edit, and a signpost
   * that oversells is worse than none. Omit when nothing comes close.
   */
  instead?: string[];
}

// Stated explicitly rather than omitted: "no alternative" is itself the answer
// an agent needs, and silence reads as an oversight worth working around.
const NO_ALTERNATIVE =
  "No gws-axi command does this yet — it needs the planned write surface, so there is nothing to fall back to";

/** Stubs are the entries with no handler. */
const stubsOf = (subs: StubbableSubcommand[]): StubbableSubcommand[] =>
  subs.filter((s) => !s.handler);

/**
 * The refusal for a scaffolded subcommand. Alternatives lead; the account
 * diagnostic and the pointer to the planned surface follow, because they are
 * context rather than a next step.
 */
export function notImplemented(
  service: string,
  sub: string,
  account: string,
  instead?: string[],
): AxiError {
  const alternatives = instead?.length ? instead : [NO_ALTERNATIVE];
  return new AxiError(`gws-axi ${service} ${sub} is not yet implemented`, "NOT_IMPLEMENTED", [
    ...alternatives,
    `See \`gws-axi ${service} ${sub} --help\` for the planned surface`,
    `Account resolution succeeded: would run as ${account}`,
  ]);
}

/** Append the `instead[N]:` block to a stubbed subcommand's own --help. */
export function withInstead(help: string, instead?: string[]): string {
  const lines = instead?.length ? instead : [NO_ALTERNATIVE];
  return `${help.trimEnd()}\ninstead[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}\n`;
}

/**
 * The service-level `alternatives[N]:` block, deduped across every stub.
 * Returns "" when the service has no stubs, so fully-implemented services
 * (calendar) gain nothing.
 */
export function renderAlternatives(subs: StubbableSubcommand[]): string {
  const lines = [...new Set(stubsOf(subs).flatMap((s) => s.instead ?? []))];
  if (lines.length === 0) return "";
  return `alternatives[${lines.length}]:\n${lines.map((l) => `  ${l}`).join("\n")}\n`;
}
