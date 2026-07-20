import type { calendar_v3 } from "googleapis";

/**
 * Conferencing / join-URL resolution for calendar events.
 *
 * Google populates the structured `conferenceData` object ONLY when the
 * conference was created through a Google-Calendar-integrated path — native
 * Google Meet, or a third-party add-on installed *in Google Calendar* (e.g.
 * the Zoom-for-GSuite add-on). A Teams/Zoom/Webex meeting that is organized
 * externally and merely *synced onto* the calendar via invite arrives as a
 * plain event: `location` gets a human label ("Microsoft Teams Meeting"), the
 * join URL lands in the `description` body, and `conferenceData` stays null.
 *
 * So a genuinely provider-uniform join URL needs a resolution chain, not a
 * single field:
 *   1. conferenceData video entryPoint uri   (Meet + add-on Zoom/Teams/Webex)
 *   2. hangoutLink                            (legacy Meet, pre-conferenceData)
 *   3. provider-anchored URL scraped from description, then location
 *                                             (externally-organized meetings)
 *
 * The `source` field discloses which link won so a consumer can trust a
 * structured hit and treat a scraped one as best-effort
 * ([principles.md#surface-completeness-limits]).
 */

export type ConferenceSource = "conferenceData" | "hangoutLink" | "description" | "location";

export interface ConferenceEntryPoint {
  type: string; // video | phone | sip | more
  uri: string;
  label: string;
}

export interface ConferenceInfo {
  /** Provider label, e.g. "Google Meet" / "Zoom" / "Microsoft Teams" / "Webex". "" if unknown. */
  provider: string;
  /** Best single tappable join URL. "" when none could be resolved. */
  joinUrl: string;
  /** Which path in the resolution chain produced `joinUrl`. "" when joinUrl is "". */
  source: ConferenceSource | "";
  /** Structured entry points from conferenceData (video/phone/sip/more). Empty when absent. */
  entryPoints: ConferenceEntryPoint[];
  /** True when `joinUrl` came from a description/location text scrape (best-effort, unverified). */
  fromScrape: boolean;
}

/**
 * Provider-anchored URL patterns for scraping a join link out of free text.
 * Anchored to known conferencing hosts + join paths — NOT "any URL" — which
 * is what makes the scrape reliable rather than the fragile grab the naive
 * approach implies. Order is priority when several providers appear.
 */
interface ProviderPattern {
  provider: string;
  re: RegExp;
}

const PROVIDER_PATTERNS: ProviderPattern[] = [
  { provider: "Google Meet", re: /https:\/\/meet\.google\.com\/[a-z0-9-]+/i },
  { provider: "Zoom", re: /https:\/\/[\w.-]*zoom\.us\/(?:j|w|my)\/[^\s<>"]+/i },
  {
    provider: "Microsoft Teams",
    re: /https:\/\/teams\.(?:microsoft|live)\.com\/(?:meet|l\/meetup-join)\/[^\s<>"]+/i,
  },
  {
    provider: "Webex",
    re: /https:\/\/[\w.-]*webex\.com\/(?:meet\/[^\s<>"]+|[^\s<>"/]+\/j\.php\?[^\s<>"]+)/i,
  },
];

/** Identify the conferencing provider from a join URL's host. "" if unrecognized. */
export function detectProvider(url: string): string {
  if (/meet\.google\.com/i.test(url)) return "Google Meet";
  if (/zoom\.us/i.test(url)) return "Zoom";
  if (/teams\.(?:microsoft|live)\.com/i.test(url)) return "Microsoft Teams";
  if (/webex\.com/i.test(url)) return "Webex";
  return "";
}

/**
 * Find the first provider-anchored join URL in a block of free text.
 * Returns the leftmost match across all provider patterns (so the "Join: <url>"
 * line near the top of a Teams/Zoom boilerplate block wins over deeper links),
 * or null when nothing matches.
 */
export function scrapeJoinUrl(text: string): { provider: string; url: string } | null {
  if (!text) return null;
  let best: { provider: string; url: string; index: number } | null = null;
  for (const { provider, re } of PROVIDER_PATTERNS) {
    const m = re.exec(text);
    if (m && (best === null || m.index < best.index)) {
      best = { provider, url: m[0], index: m.index };
    }
  }
  return best ? { provider: best.provider, url: best.url } : null;
}

/**
 * Normalize an event's conferencing into a provider-uniform shape by walking
 * the resolution chain (structured → hangoutLink → description/location scrape).
 * Returns null when the event carries no conferencing signal at all.
 */
export function extractConference(event: calendar_v3.Schema$Event): ConferenceInfo | null {
  const cd = event.conferenceData;
  const entryPoints: ConferenceEntryPoint[] = (cd?.entryPoints ?? []).map((ep) => ({
    type: ep.entryPointType ?? "",
    uri: ep.uri ?? "",
    label: ep.label ?? "",
  }));

  // 1. Structured conferenceData video entry point — the correct source when present.
  const videoEp = entryPoints.find((ep) => ep.type === "video" && ep.uri);
  if (videoEp) {
    return {
      provider: cd?.conferenceSolution?.name ?? detectProvider(videoEp.uri),
      joinUrl: videoEp.uri,
      source: "conferenceData",
      entryPoints,
      fromScrape: false,
    };
  }

  // 2. Legacy Meet hangoutLink (predates conferenceData; Meet-only).
  const hangoutLink = event.hangoutLink ?? "";
  if (hangoutLink) {
    return {
      provider: cd?.conferenceSolution?.name ?? "Google Meet",
      joinUrl: hangoutLink,
      source: "hangoutLink",
      entryPoints,
      fromScrape: false,
    };
  }

  // 3. Scrape the description, then the location — externally-organized
  //    Teams/Zoom/Webex meetings put the URL here with no conferenceData.
  const scrapeTargets: Array<[ConferenceSource, string | null | undefined]> = [
    ["description", event.description],
    ["location", event.location],
  ];
  for (const [src, text] of scrapeTargets) {
    const hit = scrapeJoinUrl(text ?? "");
    if (hit) {
      return {
        provider: hit.provider,
        joinUrl: hit.url,
        source: src,
        entryPoints,
        fromScrape: true,
      };
    }
  }

  // conferenceData present but no usable video link (e.g. phone-only) and no
  // scrape hit — surface the provider, but there's no join URL to give.
  if (cd || entryPoints.length) {
    return {
      provider: cd?.conferenceSolution?.name ?? "",
      joinUrl: "",
      source: "",
      entryPoints,
      fromScrape: false,
    };
  }

  return null;
}

/** Best single tappable join URL for an event, or "" when none resolves. */
export function resolveJoinUrl(event: calendar_v3.Schema$Event): string {
  return extractConference(event)?.joinUrl ?? "";
}
