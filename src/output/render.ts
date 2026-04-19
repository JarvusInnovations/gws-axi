import { encode } from "@toon-format/toon";
import type { FieldDef } from "./schema.js";

/**
 * Render a list of items as a TOON table with the given field schema.
 * Returns a raw TOON string (not wrapped in an object) so it can be
 * composed into a larger output.
 *
 * Output shape:
 *   <name>[N]{col1,col2,col3}:
 *     val1,val2,val3
 *     val1,val2,val3
 */
export function renderList(
  name: string,
  items: Array<Record<string, unknown>>,
  schema: FieldDef[],
): string {
  const projected = items.map((item) =>
    Object.fromEntries(schema.map((f) => [f.name, f.extract(item) ?? ""])),
  );
  return encode({ [name]: projected });
}

/**
 * Render a simple key/value object as TOON.
 */
export function renderObject(value: Record<string, unknown>): string {
  return encode(value);
}

/**
 * Render a help array. Returns empty string for empty help to keep output
 * clean.
 */
export function renderHelp(suggestions: string[]): string {
  if (suggestions.length === 0) return "";
  return encode({ help: suggestions });
}

/**
 * Join multiple rendered blocks with newlines, dropping empty ones.
 */
export function joinBlocks(...blocks: string[]): string {
  return blocks.filter((b) => b.length > 0).join("\n");
}

/**
 * Compose a list response with optional header (e.g. account info),
 * the list itself, and help suggestions. Every block is optional.
 */
export function renderListResponse(options: {
  header?: Record<string, unknown>;
  name: string;
  items: Array<Record<string, unknown>>;
  schema: FieldDef[];
  suggestions?: string[];
  /** Emitted after the header but before the list — e.g. "count: 3 of 47 total". */
  summary?: Record<string, unknown>;
  /** Message when items is empty — replaces the list block entirely. */
  emptyMessage?: string;
}): string {
  const blocks: string[] = [];
  if (options.header) blocks.push(renderObject(options.header));
  if (options.summary) blocks.push(renderObject(options.summary));
  if (options.items.length === 0) {
    blocks.push(`${options.name}: ${options.emptyMessage ?? `no ${options.name} found`}`);
  } else {
    blocks.push(renderList(options.name, options.items, options.schema));
  }
  if (options.suggestions?.length) {
    blocks.push(renderHelp(options.suggestions));
  }
  return joinBlocks(...blocks);
}
