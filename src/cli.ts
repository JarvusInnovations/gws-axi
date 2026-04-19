import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { homeCommand } from "./commands/home.js";
import { authCommand, AUTH_HELP } from "./commands/auth.js";
import { doctorCommand, DOCTOR_HELP } from "./commands/doctor.js";
import { calendarCommand } from "./commands/calendar.js";
import { gmailCommand, GMAIL_HELP } from "./commands/gmail.js";
import { docsCommand, DOCS_HELP } from "./commands/docs.js";
import { driveCommand, DRIVE_HELP } from "./commands/drive.js";
import { slidesCommand, SLIDES_HELP } from "./commands/slides.js";

const DESCRIPTION =
  "Agent ergonomic CLI for Google Workspace. Unified interface for Gmail, Calendar, Docs, Drive, and Slides with agent-guided OAuth setup.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: gws-axi [command] [args] [flags]
commands[8]:
  (none)=home, auth, doctor, calendar, gmail, docs, drive, slides
flags[2]:
  --help, -v/-V/--version
examples:
  gws-axi
  gws-axi auth setup
  gws-axi doctor
  gws-axi calendar events
`;

// Services that have real subcommand dispatchers handle --help themselves
// (so `<service> <sub> --help` shows subcommand-specific help). For stubs
// that just print help, we keep them in the SDK's auto-help map.
const COMMAND_HELP: Record<string, string> = {
  auth: AUTH_HELP,
  doctor: DOCTOR_HELP,
  gmail: GMAIL_HELP,
  docs: DOCS_HELP,
  drive: DRIVE_HELP,
  slides: SLIDES_HELP,
};

export async function main(): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    ...(process.env.GWS_AXI_DISABLE_HOOKS === "1" ? { hooks: false } : {}),
    home: async () => homeCommand(),
    commands: {
      auth: authCommand,
      doctor: doctorCommand,
      calendar: calendarCommand,
      gmail: gmailCommand,
      docs: docsCommand,
      drive: driveCommand,
      slides: slidesCommand,
    },
    getCommandHelp: (command) => COMMAND_HELP[command],
  });
}

function readPackageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ]) {
    if (!existsSync(candidate)) {
      continue;
    }

    const parsed = JSON.parse(readFileSync(candidate, "utf-8")) as {
      version?: unknown;
    };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return parsed.version;
    }
  }

  throw new Error("Could not determine gws-axi package version");
}
