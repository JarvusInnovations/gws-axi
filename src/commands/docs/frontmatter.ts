import { AxiError } from "axi-sdk-js";
import { type Node, isMap, isScalar, isSeq, parseDocument } from "yaml";

/**
 * YAML frontmatter on the way into a Doc (specs/behaviors/markdown-to-doc.md
 * § Frontmatter): metadata a Markdown file carries for tooling, stripped by
 * default or written as a label/value table. Pure, so every rule is testable
 * without Docs.
 */

export type FrontmatterMode = "strip" | "keep" | "table";

export interface Frontmatter {
  /** The Markdown after the block. */
  body: string;
  /** Top-level keys. */
  keys: number;
  /** The table's rows: dotted label → value Markdown, in document order. */
  rows: Array<{ label: string; value: string }>;
}

/** `---`, the YAML, then `---` or `...`, at the very start (after a byte-order mark). */
const BLOCK = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/**
 * The frontmatter at the start of `source`, or undefined when there is none.
 * Only a block that parses to a mapping with at least one key counts — the
 * GitHub / Jekyll convention; anything else is Markdown. A block that doesn't
 * parse at all is refused rather than written into the Doc as text.
 */
export function splitFrontmatter(source: string): Frontmatter | undefined {
  const m = BLOCK.exec(source);
  if (!m) return undefined;
  const yaml = m[1];
  const doc = parseDocument(yaml);
  if (doc.errors.length) {
    const first = doc.errors[0].message.split("\n")[0];
    throw new AxiError(`The frontmatter isn't valid YAML: ${first}`, "VALIDATION_ERROR", [
      "Fix the YAML between the opening `---` lines",
      "Or pass `--frontmatter keep` to write the block as text",
      "Nothing was written",
    ]);
  }
  if (!isMap(doc.contents) || doc.contents.items.length === 0) return undefined;
  return {
    body: source.slice(m[0].length),
    keys: doc.contents.items.length,
    rows: leaves(doc.contents, "", yaml),
  };
}

/** One row per leaf; a nested mapping's keys are dotted onto its own. */
function leaves(node: Node, prefix: string, src: string): Frontmatter["rows"] {
  const rows: Frontmatter["rows"] = [];
  if (!isMap(node)) return rows;
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const label = prefix ? `${prefix}.${key}` : key;
    const value = pair.value as Node | null;
    if (isMap(value) && value.items.length) rows.push(...leaves(value, label, src));
    else rows.push({ label, value: render(value, src) });
  }
  return rows;
}

/** A value as cell Markdown: list items joined with `<br>`, a mapping item as `k: v, k: v`. */
function render(node: Node | null | undefined, src: string): string {
  if (isSeq(node)) {
    return node.items
      .map((item) => (isMap(item) ? inlineMap(item as Node, src) : render(item as Node, src)))
      .filter((s) => s !== "")
      .join("<br>");
  }
  if (isMap(node)) return inlineMap(node, src);
  return cellText(scalar(node, src));
}

function inlineMap(node: Node, src: string): string {
  if (!isMap(node)) return "";
  return node.items
    .map((pair) => {
      const key = isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
      const value = pair.value as Node | null;
      const text =
        isMap(value) || isSeq(value) ? JSON.stringify(value.toJSON()) : scalar(value, src);
      return `${key}: ${text}`;
    })
    .map(cellText)
    .join(", ");
}

/** A scalar as the YAML spells it (`1.0` stays `1.0`, a date stays as written); null is empty. */
function scalar(node: Node | null | undefined, src: string): string {
  if (!node || !isScalar(node) || node.value === null) return "";
  if (node.type === "PLAIN" && node.range) return src.slice(node.range[0], node.range[1]).trim();
  return String(node.value);
}

/** One line of cell Markdown: newlines become `<br>`, a literal `|` is escaped. */
function cellText(text: string): string {
  return text.trim().replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/**
 * The rows `--frontmatter-keys` picks, in its order. A key names a leaf
 * (`from.version`) or a mapping (`from`: every leaf under it); an unknown key
 * is refused with the keys there are.
 */
export function selectRows(rows: Frontmatter["rows"], keys: string[]): Frontmatter["rows"] {
  const picked: Frontmatter["rows"] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const hits = rows.filter((r) => r.label === key || r.label.startsWith(`${key}.`));
    if (hits.length === 0) unknown.push(key);
    for (const hit of hits) if (!picked.includes(hit)) picked.push(hit);
  }
  if (unknown.length) {
    throw new AxiError(
      `The frontmatter has no key ${unknown.map((k) => JSON.stringify(k)).join(", ")}`,
      "VALIDATION_ERROR",
      [`Keys in the frontmatter: ${rows.map((r) => r.label).join(", ")}`, "Nothing was written"],
    );
  }
  return picked;
}

/**
 * The table's Markdown: bold labels in a fitted first column, values in the
 * second. GFM needs a delimiter row after the first; the caller writes the
 * table with no header row, so that first row is an ordinary row.
 */
export function frontmatterTableMarkdown(rows: Frontmatter["rows"]): string {
  const line = (r: { label: string; value: string }) => `| **${cellText(r.label)}** | ${r.value} |`;
  const [first, ...rest] = rows;
  return ["<!-- cols: fit 1 -->", line(first), "| --- | --- |", ...rest.map(line)].join("\n");
}
