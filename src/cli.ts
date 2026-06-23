import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAxiCli } from "axi-sdk-js";
import { homeCommand } from "./commands/home.js";
import { authCommand, AUTH_HELP } from "./commands/auth.js";
import { doctorCommand, DOCTOR_HELP } from "./commands/doctor.js";
import { calendarCommand } from "./commands/calendar.js";
import { gmailCommand } from "./commands/gmail.js";
import { docsCommand } from "./commands/docs.js";
import { driveCommand } from "./commands/drive.js";
import { slidesCommand } from "./commands/slides.js";
import { setupCommand, SETUP_HELP } from "./commands/setup.js";

const DESCRIPTION =
  "Agent ergonomic CLI for Google Workspace. Unified interface for Gmail, Calendar, Docs, Drive, and Slides with agent-guided OAuth setup.";

const VERSION = readPackageVersion();

export const TOP_HELP = `usage: gws-axi [command] [args] [flags]
commands[9]:
  (none)=home, auth, doctor, calendar, gmail, docs, drive, slides, setup
flags[2]:
  --help, -v/-V/--version
examples:
  gws-axi
  gws-axi auth setup
  gws-axi doctor
  gws-axi calendar events
  gws-axi setup hooks
`;

// Services that have real subcommand dispatchers handle --help themselves
// (so `<service> <sub> --help` shows subcommand-specific help). For stubs
// that just print help, we keep them in the SDK's auto-help map.
const COMMAND_HELP: Record<string, string> = {
  auth: AUTH_HELP,
  doctor: DOCTOR_HELP,
  setup: SETUP_HELP,
};

export async function main(): Promise<void> {
  await runAxiCli({
    description: DESCRIPTION,
    version: VERSION,
    topLevelHelp: TOP_HELP,
    home: async () => homeCommand(),
    commands: {
      auth: authCommand,
      doctor: doctorCommand,
      calendar: calendarCommand,
      gmail: gmailCommand,
      docs: docsCommand,
      drive: driveCommand,
      slides: slidesCommand,
      setup: setupCommand,
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
