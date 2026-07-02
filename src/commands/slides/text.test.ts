import { describe, expect, it } from "vitest";
import type { slides_v1 } from "googleapis";
import { extractSlideContent, linkHref, runsToMarkdown } from "./text.js";

describe("linkHref", () => {
  it("returns the url for an external link", () => {
    expect(linkHref({ url: "https://x.dev/a" })).toBe("https://x.dev/a");
  });

  it("maps a slide link to slide:<id>", () => {
    expect(linkHref({ pageObjectId: "g123" })).toBe("slide:g123");
  });

  it("ignores navigation-only links (relativeLink / slideIndex)", () => {
    expect(linkHref({ relativeLink: "NEXT_SLIDE" })).toBeUndefined();
    expect(linkHref({ slideIndex: 3 })).toBeUndefined();
    expect(linkHref(undefined)).toBeUndefined();
    expect(linkHref(null)).toBeUndefined();
  });
});

describe("runsToMarkdown", () => {
  it("joins plain runs with no links", () => {
    expect(runsToMarkdown([{ content: "hello " }, { content: "world" }])).toEqual({
      text: "hello world",
      links: 0,
    });
  });

  it("wraps a linked run as markdown", () => {
    expect(runsToMarkdown([{ content: "docs", link: "https://x.dev/a" }])).toEqual({
      text: "[docs](https://x.dev/a)",
      links: 1,
    });
  });

  it("coalesces adjacent runs sharing the same href into one link", () => {
    const out = runsToMarkdown([
      { content: "hel", link: "https://x.dev/a" },
      { content: "lo", link: "https://x.dev/a" },
    ]);
    expect(out).toEqual({ text: "[hello](https://x.dev/a)", links: 1 });
  });

  it("keeps trailing whitespace/newline outside the brackets", () => {
    const out = runsToMarkdown([{ content: "See the doc\n", link: "https://x.dev/a" }]);
    expect(out).toEqual({ text: "[See the doc](https://x.dev/a)\n", links: 1 });
  });

  it("renders distinct adjacent links separately", () => {
    const out = runsToMarkdown([
      { content: "a", link: "https://u1" },
      { content: "b", link: "https://u2" },
    ]);
    expect(out).toEqual({ text: "[a](https://u1)[b](https://u2)", links: 2 });
  });

  it("does not wrap a link run that is only whitespace", () => {
    expect(runsToMarkdown([{ content: "   ", link: "https://x.dev/a" }])).toEqual({
      text: "   ",
      links: 0,
    });
  });
});

describe("extractSlideContent — links", () => {
  it("resolves a body-shape link inline and counts it", () => {
    const slide: slides_v1.Schema$Page = {
      objectId: "p1",
      pageElements: [
        {
          shape: {
            text: {
              textElements: [
                { textRun: { content: "Intro " } },
                { textRun: { content: "GTFS spec", style: { link: { url: "https://gtfs.org" } } } },
              ],
            },
          },
        },
      ],
    };
    const content = extractSlideContent(slide, 0);
    expect(content.body).toEqual(["Intro [GTFS spec](https://gtfs.org)"]);
    expect(content.link_count).toBe(1);
  });
});
