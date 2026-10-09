/**
 * Text measurement for `fit` table columns (specs/behaviors/markdown-to-doc.md
 * § Fitted columns). The Docs API has no auto-fit, so a column that should fit
 * its content is sized here, from glyph advance widths.
 *
 * The tables are the ASCII range of Adobe's Helvetica and Helvetica-Bold
 * Core 14 AFM files — Docs' default body font, Arial, is metric-compatible
 * with Helvetica. No other font is assumed: a proportional font a tab may use
 * instead sits in the same range, and the caller adds a margin.
 *
 * Adobe Core 14 AFM metrics: Copyright (c) 1985, 1987, 1989, 1990, 1997 Adobe
 * Systems Incorporated. All Rights Reserved. Redistributed per the AFM license
 * (copyright notice retained).
 */

/** Advance widths in 1/1000 em for code points 32–126. */
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 222, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 222, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 278, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 278, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

/** Anything the tables don't cover (CJK, emoji, symbols) counts as one em — wide, so it never under-fits. */
const EM = 1000;

/**
 * Width of one code point in 1/1000 em. An accented Latin letter measures as
 * its base letter (NFD strips the mark); a combining mark itself is zero.
 */
function glyphWidth(char: string, bold: boolean): number {
  const table = bold ? HELVETICA_BOLD : HELVETICA;
  const code = char.codePointAt(0) ?? 0;
  if (code >= 32 && code <= 126) return table[code - 32];
  if (code >= 0x0300 && code <= 0x036f) return 0; // combining diacritic
  const base = char.normalize("NFD")[0];
  const baseCode = base?.codePointAt(0) ?? 0;
  if (base !== char && baseCode >= 32 && baseCode <= 126) return table[baseCode - 32];
  if (code === 0x00a0) return table[0]; // no-break space
  return EM;
}

/** Rendered width of `text` in points at `sizePt`, in Helvetica (regular or bold). */
export function measureText(text: string, options: { bold?: boolean; sizePt: number }): number {
  let units = 0;
  for (const char of text) units += glyphWidth(char, !!options.bold);
  return (units * options.sizePt) / 1000;
}
