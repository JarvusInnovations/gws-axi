# gws-axi

AXI-compliant Google Workspace CLI — a token-efficient, agent-first interface for Gmail, Calendar, Docs, Drive, and Slides.

`gws-axi` is built to the [AXI](https://github.com/kunchenguid/axi) standard: [TOON](https://toonformat.dev/)-formatted output, contextual next-step suggestions, idempotent mutations, and session-hook ambient context. Every output is optimized for AI agents to read and act on immediately.

## Install

```bash
npm install -g gws-axi
```

## First-run setup

`gws-axi` uses **bring-your-own OAuth client (BYO)** for v1 — you create your own Google Cloud project and OAuth credentials, and tokens live locally at `~/.config/gws-axi/`. The setup is progressive and agent-guided: run `gws-axi auth setup` and each invocation walks you through the next step, saving state between runs so you can stop and resume.

```bash
gws-axi auth setup   # start or continue setup
gws-axi doctor       # check setup + runtime health at any time
```

See [docs/design.md](docs/design.md) for the full design and [docs/shared-client-future.md](docs/shared-client-future.md) for why BYO (and when shared-client distribution might come later).

## Usage

Every subcommand supports `--help`. The bare `gws-axi` command prints current state and suggests next steps.

```bash
gws-axi                         # home view — state overview + suggestions
gws-axi calendar events         # list upcoming events
gws-axi calendar create ...     # create an event
gws-axi gmail list              # list recent messages
gws-axi docs read <doc-id>      # read a Google Doc
gws-axi drive search <query>    # search Drive
gws-axi slides get <slide-id>   # fetch a Slides presentation
```

## Status

**v1 — in development.** Calendar is the first service; Gmail, Docs, Drive, and Slides follow. See [docs/design.md](docs/design.md) for roadmap and command surface.

## License

MIT — see [LICENSE](LICENSE).
