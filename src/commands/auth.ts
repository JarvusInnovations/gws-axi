import { AxiError } from "axi-sdk-js";

export const AUTH_HELP = `usage: gws-axi auth <subcommand> [flags]
subcommands[4]:
  setup   Progressive agent-guided OAuth setup (run repeatedly until complete)
  login   Re-run the OAuth loopback flow (requires credentials.json in place)
  status  Terse one-line status: ok or broken:<reason>
  reset   Clear setup state, optionally from a specific step
examples:
  gws-axi auth setup
  gws-axi auth setup --credentials-json ~/Downloads/client_secret_xxx.json
  gws-axi auth login
  gws-axi auth reset --from oauth_client
`;

export async function authCommand(args: string[]): Promise<string> {
  const sub = args[0];
  if (!sub) {
    return AUTH_HELP;
  }

  if (!["setup", "login", "status", "reset"].includes(sub)) {
    throw new AxiError(
      `Unknown auth subcommand: ${sub}`,
      "VALIDATION_ERROR",
      ["Run `gws-axi auth --help` to see available subcommands"],
    );
  }

  throw new AxiError(
    `auth ${sub} is not yet implemented in v1-dev`,
    "NOT_IMPLEMENTED",
    [
      "See docs/design.md for the full BYO auth flow spec",
      "Track progress at https://github.com/JarvusInnovations/gws-axi",
    ],
  );
}
