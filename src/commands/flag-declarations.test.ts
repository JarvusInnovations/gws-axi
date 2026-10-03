import { describe, expect, it } from "vitest";
import { AxiError } from "axi-sdk-js";
import { SUBCOMMANDS as calendar } from "./calendar.js";
import { SUBCOMMANDS as chat } from "./chat.js";
import { SUBCOMMANDS as docs } from "./docs.js";
import { SUBCOMMANDS as drive } from "./drive.js";
import { SUBCOMMANDS as gmail } from "./gmail.js";
import { SUBCOMMANDS as sheets } from "./sheets.js";
import { SUBCOMMANDS as slides } from "./slides.js";
import { checkFlags, type FlagSpec } from "../util/flags.js";

/**
 * Every command fails loud on a flag it doesn't take
 * (specs/principles.md#fail-loud-on-unknown-flags). These tests keep the
 * declarations complete and in step with each command's --help.
 */

interface Sub {
  name: string;
  help: string;
  handler?: unknown;
  flags?: FlagSpec | "self";
}

const SERVICES: Record<string, Sub[]> = { calendar, chat, docs, drive, gmail, sheets, slides };

/** Flags a help text documents: `--name` at the start of an indented line. */
function documentedFlags(help: string): Set<string> {
  const found = new Set<string>();
  for (const line of help.split("\n")) {
    const m = /^\s{2,}(--[a-z][\w-]*)/.exec(line);
    if (m) found.add(m[1]);
  }
  found.delete("--account");
  found.delete("--help");
  return found;
}

describe("flag declarations", () => {
  for (const [service, subs] of Object.entries(SERVICES)) {
    for (const sub of subs.filter((s) => s.handler)) {
      const command = `${service} ${sub.name}`;

      it(`${command} declares its flags`, () => {
        expect(sub.flags, `${command} has no flags declaration`).toBeDefined();
      });

      if (sub.flags && sub.flags !== "self") {
        const spec = sub.flags;
        it(`${command} declares exactly the flags its --help documents`, () => {
          const declared = new Set([...(spec.value ?? []), ...(spec.boolean ?? [])]);
          expect([...declared].sort()).toEqual([...documentedFlags(sub.help)].sort());
        });

        it(`${command} rejects an unknown flag`, () => {
          let code = "none";
          try {
            checkFlags(["--definitely-not-a-flag"], spec, command);
          } catch (err) {
            code = (err as AxiError).code;
          }
          expect(code).toBe("VALIDATION_ERROR");
        });
      }
    }
  }
});

describe("top-level commands", () => {
  async function codeOf(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (err) {
      return (err as AxiError).code;
    }
    return "none";
  }

  it("auth subcommands reject unknown flags before doing anything", async () => {
    const { authCommand } = await import("./auth.js");
    expect(await codeOf(() => authCommand(["login", "--url", "x"]))).toBe("VALIDATION_ERROR");
    expect(await codeOf(() => authCommand(["status", "--verbose"]))).toBe("VALIDATION_ERROR");
  });

  it("doctor rejects unknown flags", async () => {
    const { doctorCommand } = await import("./doctor.js");
    expect(await codeOf(() => doctorCommand(["--fix"]))).toBe("VALIDATION_ERROR");
  });
});

describe("--fields names", () => {
  it("are matched exactly and refused when unknown", async () => {
    const { parseFieldList } = await import("../util/flags.js");
    expect(parseFieldList("--fields", "htmlLink, status", ["status", "htmlLink"])).toEqual([
      "htmlLink",
      "status",
    ]);
    expect(() => parseFieldList("--fields", "status,colour", ["status"])).toThrow(/colour/);
  });
});
