import { AxiError } from "axi-sdk-js";
import type { slides_v1 } from "googleapis";
import { slidesClient, translateGoogleError } from "../../google/client.js";
import { field, joinBlocks, renderHelp, renderList, renderObject } from "../../output/index.js";
import { parseArgs } from "../../util/flags.js";
import { extractSlideContent, isSlidePage } from "./text.js";

/**
 * `slides skip` / `slides unskip` (specs/commands/slides-skip.md): hide or show
 * slides in presentation mode via `updateSlideProperties.isSkipped`. One
 * `presentations.get` decides which slides actually change; only those are
 * written, and an all-unchanged call writes nothing.
 */

const helpFor = (
  verb: "skip" | "unskip",
) => `usage: gws-axi slides ${verb} <presentation-id> <page-id>... [flags]
args[2]:
  <presentation-id>    The deck
  <page-id>...         One or more slides, by page_id from \`slides get\`
flags[1]:
  --account <email>    REQUIRED when 2+ accounts are authenticated (or set GWS_AXI_ACCOUNT)
examples:
  gws-axi slides ${verb} 1DeCk... g2a1b_0_12 --account you@example.com
  gws-axi slides ${verb} 1DeCk... g2a1b_0_12 g2a1b_0_19 --account you@example.com
output:
  \`action\` (${verb === "skip" ? "skipped" : "unskipped"} | unchanged), \`changed: N of M\`, and a
  slides[N]{index,page_id,title,skipped} table of the slides named.
notes:
  ${
    verb === "skip"
      ? "A skipped slide stays in the deck and in `slides summarize`; it is only hidden in\n  presentation mode. `slides unskip` shows it again."
      : "Shows slides that `slides skip` (or the editor's Skip slide) hid in presentation mode."
  }
  Slides already in the requested state are left alone.
`;

export const SKIP_HELP = helpFor("skip");
export const UNSKIP_HELP = helpFor("unskip");

export function parseSkipArgs(
  args: string[],
  verb: "skip" | "unskip",
): { presentationId: string; pageIds: string[] } {
  const parsed = parseArgs(args, {}, `slides ${verb}`);
  const [presentationId, ...pageIds] = parsed.positionals;
  if (!presentationId || pageIds.length === 0) {
    throw new AxiError(
      presentationId ? "Name at least one slide by page_id" : "Missing presentation id",
      "VALIDATION_ERROR",
      [
        `Usage: gws-axi slides ${verb} <presentation-id> <page-id>...`,
        "Page ids are in the page_id column of `gws-axi slides get <presentation-id>`",
      ],
    );
  }
  return { presentationId, pageIds: [...new Set(pageIds)] };
}

export interface SlideState {
  index: number;
  page_id: string;
  title: string;
  skipped: boolean;
}

/** The named slides, and which of them need a write to reach `want`. */
export function planSkip(
  slides: SlideState[],
  pageIds: string[],
  want: boolean,
): { named: SlideState[]; change: SlideState[]; missing: string[] } {
  const byId = new Map(slides.map((s) => [s.page_id, s]));
  const missing = pageIds.filter((id) => !byId.has(id));
  const named = pageIds.filter((id) => byId.has(id)).map((id) => byId.get(id)!);
  return { named, change: named.filter((s) => s.skipped !== want), missing };
}

function notFound(presentationId: string, account: string): AxiError {
  return new AxiError(
    `Presentation '${presentationId}' not found (or ${account} doesn't have access)`,
    "PRESENTATION_NOT_FOUND",
    [
      "Verify the presentation ID is correct (the portion of the URL after /d/)",
      `Confirm ${account} has edit access`,
    ],
  );
}

async function readSlides(
  api: slides_v1.Slides,
  account: string,
  presentationId: string,
): Promise<SlideState[]> {
  try {
    const res = await api.presentations.get({ presentationId });
    return (res.data.slides ?? []).filter(isSlidePage).map((page, i) => {
      const c = extractSlideContent(page, i);
      return { index: i + 1, page_id: c.page_id, title: c.title, skipped: c.skipped };
    });
  } catch (err) {
    const translated = translateGoogleError(err, {
      account,
      operation: "slides.presentations.get",
    });
    if (translated.code === "NOT_FOUND") throw notFound(presentationId, account);
    throw translated;
  }
}

async function run(account: string, args: string[], verb: "skip" | "unskip"): Promise<string> {
  const want = verb === "skip";
  const flags = parseSkipArgs(args, verb);
  const api = await slidesClient(account);
  const slides = await readSlides(api, account, flags.presentationId);
  const plan = planSkip(slides, flags.pageIds, want);
  if (plan.missing.length) {
    throw new AxiError(
      `No slide with page_id ${plan.missing.join(", ")} in this presentation`,
      "PAGE_NOT_FOUND",
      [
        `Run \`gws-axi slides get ${flags.presentationId}\` for the page_id column`,
        "Nothing was changed",
      ],
    );
  }

  if (plan.change.length) {
    try {
      await api.presentations.batchUpdate({
        presentationId: flags.presentationId,
        requestBody: {
          requests: plan.change.map((s) => ({
            updateSlideProperties: {
              objectId: s.page_id,
              slideProperties: { isSkipped: want },
              fields: "isSkipped",
            },
          })),
        },
      });
    } catch (err) {
      const translated = translateGoogleError(err, {
        account,
        operation: "slides.presentations.batchUpdate",
      });
      if (translated.code === "NOT_FOUND") throw notFound(flags.presentationId, account);
      if (translated.code === "FORBIDDEN") {
        translated.suggestions.unshift(
          `Changing slides needs edit access; ${account} may not have it`,
        );
      }
      throw translated;
    }
    for (const s of plan.change) s.skipped = want;
  }

  const other = want ? "unskip" : "skip";
  const help = [`Run \`gws-axi slides get ${flags.presentationId}\` to see every slide's state`];
  if (plan.change.length) {
    help.push(
      `Run \`gws-axi slides ${other} ${flags.presentationId} ${plan.change.map((s) => s.page_id).join(" ")} --account ${account}\` to undo`,
    );
  }
  return joinBlocks(
    renderObject({ account }),
    renderObject({
      action: plan.change.length ? (want ? "skipped" : "unskipped") : "unchanged",
      changed: `${plan.change.length} of ${plan.named.length}`,
    }),
    renderList("slides", plan.named as unknown as Array<Record<string, unknown>>, [
      field("index"),
      field("page_id"),
      field("title"),
      { name: "skipped", extract: (item) => (item.skipped ? "✓" : "") },
    ]),
    renderHelp(help),
  );
}

export const slidesSkipCommand = (account: string, args: string[]) => run(account, args, "skip");
export const slidesUnskipCommand = (account: string, args: string[]) =>
  run(account, args, "unskip");
