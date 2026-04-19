import { AxiError } from "axi-sdk-js";

export function buildServiceStub(service: string, subcommands: string[]): {
  help: string;
  command: (args: string[]) => Promise<string>;
} {
  const help = `usage: gws-axi ${service} <subcommand> [args] [flags]
subcommands[${subcommands.length}]:
  ${subcommands.join(", ")}
status: ${service} is not yet implemented in v1-dev
see: docs/design.md in the gws-axi repo for the full command surface plan
`;

  const command = async (args: string[]): Promise<string> => {
    if (args.length === 0) {
      return help;
    }

    throw new AxiError(
      `gws-axi ${service} ${args[0]} is not yet implemented in v1-dev`,
      "NOT_IMPLEMENTED",
      [
        `Run \`gws-axi ${service} --help\` for the planned command surface`,
        "See docs/design.md for implementation roadmap",
      ],
    );
  };

  return { help, command };
}
