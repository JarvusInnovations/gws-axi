/**
 * Shared schema builders for TOON table rendering. Each FieldDef is a
 * projection from a source object (usually a Google API response row)
 * onto a named column in the output table.
 *
 * Usage:
 *   const schema = [
 *     field("id"),
 *     pluck("creator", "email", "creator_email"),
 *     mapEnum("status", { confirmed: "✓", tentative: "?" }, "unknown"),
 *     lower("visibility"),
 *   ];
 *   renderList("events", items, schema);
 */

export interface FieldDef {
  name: string;
  extract: (item: Record<string, unknown>) => unknown;
}

export function field(name: string): FieldDef {
  return { name, extract: (item) => item[name] };
}

export function lower(name: string): FieldDef {
  return {
    name,
    extract: (item) => {
      const value = item[name];
      return typeof value === "string" ? value.toLowerCase() : value;
    },
  };
}

export function pluck(
  parent: string,
  child: string,
  alias?: string,
): FieldDef {
  return {
    name: alias ?? `${parent}_${child}`,
    extract: (item) => {
      const parentVal = item[parent] as Record<string, unknown> | undefined;
      return parentVal?.[child];
    },
  };
}

export function mapEnum(
  name: string,
  mapping: Record<string, string>,
  fallback: string,
  alias?: string,
): FieldDef {
  return {
    name: alias ?? name,
    extract: (item) => {
      const value = item[name];
      if (typeof value !== "string") return fallback;
      return mapping[value] ?? fallback;
    },
  };
}

/**
 * Compute a field from the whole item. Use for derived values (e.g.
 * "5/8 attendees confirmed", "tomorrow 2pm").
 */
export function computed(
  name: string,
  fn: (item: Record<string, unknown>) => unknown,
): FieldDef {
  return { name, extract: fn };
}

/**
 * Truncate a string to `max` chars with ellipsis. Returns the original
 * value when it's not a string.
 */
export function truncated(name: string, max: number, alias?: string): FieldDef {
  return {
    name: alias ?? name,
    extract: (item) => {
      const value = item[name];
      if (typeof value !== "string") return value;
      return value.length > max ? `${value.slice(0, max - 1)}…` : value;
    },
  };
}
