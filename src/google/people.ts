import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AxiError } from "axi-sdk-js";
import { peoplePathForAccount, profilePathForAccount } from "../config.js";
import { peopleClient, withRateLimitRetry } from "./client.js";
import { readTokens } from "./tokens.js";

/**
 * The shared people resolver: turns the ids some APIs return in place of a
 * person (`people/{id}` from Drive Activity, `users/{id}` from Chat) into a
 * name and an email.
 *
 * Two properties every caller relies on:
 *
 * - **It never throws.** A lookup that can't happen — scope not granted, API
 *   not enabled, network error — returns what the cache and the account's own
 *   profile could answer, plus a `degraded` note naming the fix. Resolution
 *   decorates a read; it must not be able to fail one.
 * - **Its coverage is the account's own directory.** People outside it come
 *   back unresolved, and callers disclose that rather than retrying.
 *
 * See specs/api/conventions.md § People.
 */

export const DIRECTORY_SCOPE = "https://www.googleapis.com/auth/directory.readonly";

const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;
/** people.getBatchGet's documented ceiling on resourceNames per call. */
const BATCH_SIZE = 200;

export interface Person {
  /** Bare id — the part after `people/` or `users/`. */
  id: string;
  name: string;
  /** Empty when the directory gave a name but no address. */
  email: string;
}

export interface PeopleResolution {
  /** Everyone who resolved, keyed by bare id. Absent ids did not resolve. */
  people: Map<string, Person>;
  /** Set when a lookup was needed but could not be made; says how to fix it. */
  degraded?: string;
}

interface CachedPerson {
  name: string;
  email: string;
  fetched: string;
}

type CacheFile = Record<string, CachedPerson>;

/** One entry of a people.getBatchGet response, as far as we read it. */
export interface BatchEntry {
  requestedResourceName?: string | null;
  person?: {
    names?: Array<{ displayName?: string | null; metadata?: { primary?: boolean | null } }>;
    emailAddresses?: Array<{ value?: string | null; metadata?: { primary?: boolean | null } }>;
  };
}

export interface ResolveDeps {
  now?: Date;
  /** Swapped out in tests; the default calls the People API. */
  lookup?: (account: string, ids: string[]) => Promise<BatchEntry[]>;
  /** Swapped out in tests; the default reads the stored token's scopes. */
  hasDirectoryScope?: (account: string) => boolean;
}

/**
 * The bare id from any spelling of a person reference, or `undefined` for one
 * that names no individual (`users/all`, `users/app`, an empty string).
 */
export function personId(ref: string | null | undefined): string | undefined {
  if (!ref) return undefined;
  const bare = ref.replace(/^(people|users)\//, "").trim();
  return /^\d+$/.test(bare) ? bare : undefined;
}

function primaryOf<T extends { metadata?: { primary?: boolean | null } }>(
  items: T[] | undefined,
): T | undefined {
  if (!items?.length) return undefined;
  return items.find((item) => item.metadata?.primary) ?? items[0];
}

/**
 * People named by a batch response. The API answers for every id it was asked
 * about, returning an empty person for anyone it can't name — those are
 * dropped, as is a name that is present but blank.
 */
export function parseBatch(entries: BatchEntry[]): Person[] {
  const people: Person[] = [];
  for (const entry of entries) {
    const id = personId(entry.requestedResourceName);
    const name = primaryOf(entry.person?.names)?.displayName?.trim();
    if (!id || !name) continue;
    const email = primaryOf(entry.person?.emailAddresses)?.value?.trim() ?? "";
    people.push({ id, name, email });
  }
  return people;
}

/** Unexpired cache entries. A missing or corrupt file is simply empty. */
export function readPeopleCache(account: string, now: Date = new Date()): Map<string, Person> {
  const fresh = new Map<string, Person>();
  try {
    const path = peoplePathForAccount(account);
    if (!existsSync(path)) return fresh;
    const cached = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
    for (const [id, entry] of Object.entries(cached)) {
      if (!personId(id) || typeof entry?.name !== "string" || !entry.name.trim()) continue;
      const age = now.getTime() - new Date(entry.fetched).getTime();
      if (!Number.isFinite(age) || age < 0 || age >= CACHE_TTL_MS) continue;
      fresh.set(id, {
        id,
        name: entry.name,
        email: typeof entry.email === "string" ? entry.email : "",
      });
    }
  } catch {
    // Corrupt or unreadable cache is a cache miss, never an error.
  }
  return fresh;
}

export function writePeopleCache(account: string, people: Person[], now: Date = new Date()): void {
  if (people.length === 0) return;
  try {
    const path = peoplePathForAccount(account);
    mkdirSync(dirname(path), { recursive: true });
    // Merge so entries this call didn't touch keep their own timestamps.
    let existing: CacheFile = {};
    if (existsSync(path)) {
      try {
        existing = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
      } catch {
        existing = {};
      }
    }
    const fetched = now.toISOString();
    for (const person of people) {
      existing[person.id] = { name: person.name, email: person.email, fetched };
    }
    // Names and addresses of other people: same permissions as the tokens.
    writeFileSync(path, `${JSON.stringify(existing, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // A cache we can't persist just means we look up again next time.
  }
}

/** The account itself, from the profile sign-in stored — no lookup needed. */
function selfFromProfile(account: string): Person | undefined {
  try {
    const path = profilePathForAccount(account);
    if (!existsSync(path)) return undefined;
    const profile = JSON.parse(readFileSync(path, "utf-8")) as {
      sub?: unknown;
      name?: unknown;
      email?: unknown;
    };
    const id = personId(typeof profile.sub === "string" ? profile.sub : undefined);
    const name = typeof profile.name === "string" ? profile.name.trim() : "";
    if (!id || !name) return undefined;
    return { id, name, email: typeof profile.email === "string" ? profile.email : account };
  } catch {
    return undefined;
  }
}

async function lookupViaApi(account: string, ids: string[]): Promise<BatchEntry[]> {
  const api = await peopleClient(account);
  const entries: BatchEntry[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const resourceNames = ids.slice(i, i + BATCH_SIZE).map((id) => `people/${id}`);
    const res = await withRateLimitRetry({ account, operation: "people.people.getBatchGet" }, () =>
      api.people.getBatchGet({ resourceNames, personFields: "names,emailAddresses" }),
    );
    entries.push(...((res.data.responses ?? []) as BatchEntry[]));
  }
  return entries;
}

function tokenHasDirectoryScope(account: string): boolean {
  const scope = readTokens(account)?.scope ?? "";
  return scope.split(" ").includes(DIRECTORY_SCOPE);
}

const REAUTH = (account: string): string =>
  `run \`gws-axi auth login --account ${account} --no-wait\` to grant it`;

/** Why a lookup failed, phrased as the fix. */
function degradedNote(account: string, err: unknown): string {
  const axi = err as Partial<AxiError>;
  if (axi.code === "SCOPE_MISSING") {
    return `Names unavailable: ${account} has not granted directory.readonly — ${REAUTH(account)}`;
  }
  if (axi.code === "API_NOT_ENABLED") {
    const fix = axi.suggestions?.[0] ?? "enable people.googleapis.com on the project";
    return `Names unavailable: the People API is not enabled — ${fix}`;
  }
  const detail = axi.code ?? (err instanceof Error ? err.message : String(err));
  return `Names unavailable: the People API lookup failed (${detail}); ids are shown instead`;
}

/**
 * Resolve a set of person references for `account`. Accepts any spelling and
 * any duplicates; references that name no individual are ignored.
 */
export async function resolvePeople(
  account: string,
  refs: Iterable<string | null | undefined>,
  deps: ResolveDeps = {},
): Promise<PeopleResolution> {
  const now = deps.now ?? new Date();
  const wanted = new Set<string>();
  for (const ref of refs) {
    const id = personId(ref);
    if (id) wanted.add(id);
  }

  const people = new Map<string, Person>();
  if (wanted.size === 0) return { people };

  const self = selfFromProfile(account);
  if (self && wanted.has(self.id)) people.set(self.id, self);

  const cached = readPeopleCache(account, now);
  for (const id of wanted) {
    const hit = cached.get(id);
    if (hit && !people.has(id)) people.set(id, hit);
  }

  const missing = [...wanted].filter((id) => !people.has(id));
  if (missing.length === 0) return { people };

  // Checked up front so an account that predates the scope costs no API call
  // and gets advice that actually fixes it.
  const hasScope = deps.hasDirectoryScope ?? tokenHasDirectoryScope;
  if (!hasScope(account)) {
    return {
      people,
      degraded: `Names unavailable: ${account} has not granted directory.readonly — ${REAUTH(account)}`,
    };
  }

  try {
    const found = parseBatch(await (deps.lookup ?? lookupViaApi)(account, missing));
    writePeopleCache(account, found, now);
    for (const person of found) people.set(person.id, person);
    return { people };
  } catch (err) {
    return { people, degraded: degradedNote(account, err) };
  }
}

/** How many of `refs` name an individual who did not resolve. */
export function countUnresolved(
  refs: Iterable<string | null | undefined>,
  resolution: PeopleResolution,
): number {
  const ids = new Set<string>();
  for (const ref of refs) {
    const id = personId(ref);
    if (id) ids.add(id);
  }
  return [...ids].filter((id) => !resolution.people.has(id)).length;
}

export const OUTSIDE_DIRECTORY_NOTE =
  "Names come from this account's own directory. People outside it — other organizations, personal accounts — can't be named and are shown by id.";
