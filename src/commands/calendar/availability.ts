import { AxiError } from "axi-sdk-js";
import type { calendar_v3 } from "googleapis";

/**
 * Free/busy on an event — the Calendar API's `transparency`, under the names
 * the Calendar UI uses ("Show as: Free / Busy"). See
 * specs/commands/calendar-availability.md.
 */

export type Availability = "free" | "busy";

export const TRANSPARENCY: Record<Availability, string> = {
  free: "transparent",
  busy: "opaque",
};

/** An event's availability. Google omits `transparency` for the default, opaque. */
export function availabilityOf(
  event: Pick<calendar_v3.Schema$Event, "transparency">,
): Availability {
  return event.transparency === "transparent" ? "free" : "busy";
}

export function setAvailability(current: Availability | undefined, flag: string): Availability {
  const next: Availability = flag === "--free" ? "free" : "busy";
  if (current && current !== next) {
    throw new AxiError("--free and --busy are mutually exclusive", "VALIDATION_ERROR", [
      "Pass one: --free (doesn't block availability) or --busy",
    ]);
  }
  return next;
}

/**
 * Fail loud on a flag the command doesn't know. A dropped flag reported
 * success here once — `--transparency transparent` on `update` did nothing and
 * the output read as if it had (#62).
 */
export function rejectUnknownFlag(arg: string, command: string, known: string[]): never | void {
  if (!arg.startsWith("--")) return;
  const hint = arg === "--transparency" ? ["Use --free or --busy to set availability"] : [];
  throw new AxiError(`Unknown flag ${arg} for \`calendar ${command}\``, "VALIDATION_ERROR", [
    ...hint,
    `Valid flags: ${[...known, "--account"].join(", ")}`,
  ]);
}
