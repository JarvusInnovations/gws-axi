/**
 * Levenshtein distance between two strings. Iterative DP, O(|a|·|b|) time
 * and O(|b|) space. Used for catching close-match typos in user-provided
 * arguments (e.g., --account emails) without pulling in a dependency.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev: number[] = new Array(b.length + 1);
  const curr: number[] = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

/**
 * Find the closest match in `candidates` to `value` within an edit-distance
 * threshold. Returns undefined if `value` is an exact match (no typo) or
 * no candidate is within the threshold. Length-difference is also bounded
 * because edit-distance alone can falsely match short strings ("a" vs "b"
 * has distance 1 but isn't a meaningful typo signal).
 */
export function findLikelyTypo(
  value: string,
  candidates: readonly string[],
  maxDistance = 2,
): string | undefined {
  if (candidates.includes(value)) return undefined;
  let bestMatch: string | undefined;
  let bestDistance = maxDistance + 1;
  for (const candidate of candidates) {
    if (Math.abs(candidate.length - value.length) > maxDistance) continue;
    const d = editDistance(candidate, value);
    if (d > 0 && d <= maxDistance && d < bestDistance) {
      bestMatch = candidate;
      bestDistance = d;
    }
  }
  return bestMatch;
}
