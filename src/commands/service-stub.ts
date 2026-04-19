import { AxiError } from "axi-sdk-js";
import {
  accountHeaderFields,
  resolveAccount,
} from "../google/account.js";

export interface ServiceSubcommand {
  name: string;
  mutation: boolean;
}

function parseAccountFlag(args: string[]): {
  account: string | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  let account: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--account" && args[i + 1]) {
      account = args[i + 1];
      i++;
      continue;
    }
    rest.push(arg);
  }
  return { account, rest };
}

export function buildServiceStub(
  service: string,
  subcommands: ServiceSubcommand[],
): {
  help: string;
  command: (args: string[]) => Promise<Record<string, unknown>>;
} {
  const readOps = subcommands.filter((s) => !s.mutation).map((s) => s.name);
  const writeOps = subcommands.filter((s) => s.mutation).map((s) => s.name);
  const help = `usage: gws-axi ${service} <subcommand> [args] [--account <email>] [flags]
reads[${readOps.length}]:
  ${readOps.join(", ") || "(none)"}
writes[${writeOps.length}]:
  ${writeOps.join(", ") || "(none)"}
status: ${service} is not yet implemented in v1-dev
see: docs/design.md for the full command surface plan
notes:
  Writes require --account <email> when 2+ accounts are authenticated.
  Reads use the default account when --account is not provided.
`;

  const command = async (args: string[]): Promise<Record<string, unknown>> => {
    if (args.length === 0) {
      // Return help as structured output so it integrates with TOON
      return {
        service,
        status: "not_implemented",
        reads: readOps,
        writes: writeOps,
        help: [
          `Run \`gws-axi ${service} --help\` for details`,
          "See docs/design.md for implementation roadmap",
        ],
      };
    }

    const sub = args[0];
    const def = subcommands.find((s) => s.name === sub);
    if (!def) {
      throw new AxiError(
        `Unknown ${service} subcommand: ${sub}`,
        "VALIDATION_ERROR",
        [`Run \`gws-axi ${service} --help\` to see available subcommands`],
      );
    }

    // Account resolution runs even though the operation is stubbed — this
    // exercises write-protection and error paths without needing real API
    // plumbing, and gives users an accurate preview of the multi-account
    // error messages they'd see in production.
    const { account } = parseAccountFlag(args.slice(1));
    const resolution = resolveAccount(account, {
      mutation: def.mutation,
      commandName: `${service} ${sub}`,
    });

    throw new AxiError(
      `gws-axi ${service} ${sub} is not yet implemented in v1-dev`,
      "NOT_IMPLEMENTED",
      [
        `Account resolution succeeded: would run as ${resolution.account}`,
        `Run \`gws-axi ${service} --help\` for the planned command surface`,
        "See docs/design.md for implementation roadmap",
      ],
    );
  };

  return { help, command };
}
