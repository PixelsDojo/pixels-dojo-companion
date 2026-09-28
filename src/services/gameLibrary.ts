import fs from "fs";
import path from "path";
import { countLocaleKeys, upsertLocaleKeys, getAllLocaleRows, STATIC_DIR } from "../db/database";

const PIXELS_SERVER =
  process.env.PIXELS_SERVER ?? "https://pixels-server.pixels.xyz";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://pixels.xyz",
  Referer: "https://pixels.xyz/",
};

const CACHE_TTL_MS = 60_000;
const LOCALE_REFRESH_INTERVAL_MS = 24 * 60 * 60_000; // 24 h

// Single cache for the full library response — both fetchItems and
// fetchAchievements share it so one HTTP call serves both.
let libraryCache: { data: Record<string, any>; expiresAt: number } | null = null;

async function fetchLibrary(): Promise<Record<string, any>> {
  const now = Date.now();
  if (libraryCache && libraryCache.expiresAt > now) return libraryCache.data;

  const url = `${PIXELS_SERVER}/v1/game/library?tenant=pixels&ver=10.5&v=${now}`;
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`upstream ${res.status}`), { status: res.status, body });
    }
    const data = await res.json() as any;
    libraryCache = { data, expiresAt: now + CACHE_TTL_MS };
    return data;
  } catch (err) {
    // Fall back to repo-shipped snapshot when upstream is unreachable.
    const filePath = path.join(STATIC_DIR, "library_10.5.json");
    if (fs.existsSync(filePath)) {
      console.warn(`[gameLibrary] upstream unavailable (${(err as Error).message}) — loading ${filePath}`);
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      libraryCache = { data, expiresAt: now + CACHE_TTL_MS };
      return data;
    }
    throw err;
  }
}

/** Items dictionary — `library.items`, 60 s cached. */
export async function fetchItems(): Promise<Record<string, any>> {
  return (await fetchLibrary()).items ?? {};
}

/** Achievements dictionary — `library.achievements`, 60 s cached (same request as fetchItems). */
export async function fetchAchievements(): Promise<Record<string, any>> {
  return (await fetchLibrary()).achievements ?? {};
}

/** Entities dictionary — `library.entities`, 60 s cached (same request as fetchItems). */
export async function fetchEntities(): Promise<Record<string, any>> {
  return (await fetchLibrary()).entities ?? {};
}

// ---------------------------------------------------------------------------
// Locale DB helpers
// ---------------------------------------------------------------------------

/**
 * Seed game_locale from data/i18n_en.json if the table is empty.
 * Called once on startup before the first live refresh.
 */
export function seedLocaleFromFile(): void {
  if (countLocaleKeys() > 0) return;

  const filePath = path.join(STATIC_DIR, "i18n_en.json");
  if (!fs.existsSync(filePath)) {
    console.warn("[gameLibrary] seed file not found:", filePath);
    return;
  }

  try {
    const raw: Record<string, string> = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const entries = Object.entries(raw)
      .filter(([, v]) => typeof v === "string")
      .map(([key, text]) => ({ key, text }));

    // Use first_seen = 0 so seeded keys never appear in "new keys" queries.
    const { upserted } = upsertLocaleKeys(entries, 0);
    console.log(`[gameLibrary] seeded game_locale with ${upserted} keys from ${filePath}`);
  } catch (err) {
    console.error("[gameLibrary] seed failed:", err);
  }
}

/**
 * Fetch the live i18n endpoint and upsert all keys into game_locale.
 * Logs a list of NEW _name keys since the last refresh (new game items/entities).
 * Invalidates the in-memory locale cache so the next fetchLocaleNameMap call
 * re-builds from the updated DB.
 */
export async function refreshLocaleFromUpstream(): Promise<void> {
  const i18nUrl = `${PIXELS_SERVER}/v1/i18n/game/en?tenant=pixels`;
  try {
    const res = await fetch(i18nUrl, { headers: HEADERS });
    if (!res.ok) {
      console.warn(`[gameLibrary] refreshLocaleFromUpstream: upstream ${res.status} — skipping`);
      return;
    }

    const raw = await res.json() as Record<string, string>;
    const entries = Object.entries(raw)
      .filter(([, v]) => typeof v === "string")
      .map(([key, text]) => ({ key, text }));

    const now = Date.now();
    const { upserted, newKeys } = upsertLocaleKeys(entries, now);

    const newNameKeys = newKeys.filter((k) => k.endsWith("_name"));
    if (newNameKeys.length > 0) {
      console.log(
        `[gameLibrary] refreshLocaleFromUpstream: ${newNameKeys.length} NEW _name keys:\n` +
        newNameKeys.map((k) => `  ${k} = ${raw[k] ?? "?"}`).join("\n"),
      );
    } else {
      console.log(`[gameLibrary] refreshLocaleFromUpstream: upserted ${upserted} keys, no new _name keys`);
    }

    // Invalidate in-memory locale cache so the next call re-builds from DB.
    localeCache = null;
  } catch (err) {
    console.error("[gameLibrary] refreshLocaleFromUpstream failed:", err);
  }
}

/**
 * Initialise the locale subsystem: seed from file if DB is empty, then run
 * a live refresh immediately, then schedule 24 h repeating refreshes.
 * Call once from index.ts after the server starts listening.
 */
export function startLocaleRefresh(): void {
  seedLocaleFromFile();
  // Run first live refresh in the background (don't block startup).
  void refreshLocaleFromUpstream();
  setInterval(() => { void refreshLocaleFromUpstream(); }, LOCALE_REFRESH_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Locale name map — in-memory cache on top of the DB.
// ---------------------------------------------------------------------------

// Locale name map cache — itemId/entityId → display name (English).
let localeCache: { data: Record<string, string>; expiresAt: number } | null = null;

/**
 * Build the validated realId→displayName map from a flat key→text dictionary.
 *
 * Problem: 682+ display names map to MORE THAN ONE key — stale IDs
 * (e.g. "itm_clay" for "Clayum Matrix"), and ach_ achievement keys that
 * share a display name with the real itm_ item.
 *
 * Algorithm:
 *  1. Parse only "_name" keys; strip suffix to get candidate ID.
 *  2. Group candidates by display name.
 *  3. For each group:
 *     - itm_ candidates: keep only those that exist in allItems.
 *       If multiple survive, sort alphabetically and use the first (lowest-numbered).
 *     - ent_ candidates: same but validated against allEntities.
 *     - ach_ candidates: ignored (recipe/achievement keys, not item IDs).
 *  4. If the library is unavailable (empty allItems), fall back to including all
 *     itm_ keys to avoid a completely empty map.
 */
function buildNameMapFromRaw(
  raw: Record<string, string>,
  allItems: Record<string, any>,
  allEntities: Record<string, any>,
): { data: Record<string, string>; ambiguous: number; dropped: number } {
  const libraryAvailable = Object.keys(allItems).length > 0;

  const nameToIds = new Map<string, string[]>();
  for (const [key, displayName] of Object.entries(raw)) {
    if (typeof displayName !== "string" || !key.endsWith("_name")) continue;
    const id = key.slice(0, -5);
    if (!nameToIds.has(displayName)) nameToIds.set(displayName, []);
    nameToIds.get(displayName)!.push(id);
  }

  const data: Record<string, string> = {};
  let ambiguous = 0;
  let dropped = 0;

  for (const [displayName, ids] of nameToIds) {
    const rawItemIds  = ids.filter((id) => id.startsWith("itm_"));
    const validItemIds = libraryAvailable
      ? rawItemIds.filter((id) => allItems[id] !== undefined)
      : rawItemIds;

    if (validItemIds.length > 0) {
      validItemIds.sort();
      if (validItemIds.length > 1) {
        ambiguous++;
      } else if (rawItemIds.length > validItemIds.length) {
        dropped += rawItemIds.length - validItemIds.length;
      }
      data[validItemIds[0]] = displayName;
    }

    const validEntityIds = ids
      .filter((id) => id.startsWith("ent_"))
      .filter((id) => !libraryAvailable || allEntities[id] !== undefined);
    for (const entId of validEntityIds) {
      data[entId] = displayName;
    }
    // ach_ IDs intentionally ignored — recipe/achievement keys, not item IDs.
  }

  return { data, ambiguous, dropped };
}

/**
 * Returns the validated realId→displayName map, 60 s in-memory cached.
 *
 * Source priority:
 *  1. In-memory cache (if fresh).
 *  2. game_locale DB (if non-empty) — validated against live library.
 *  3. Live i18n endpoint (only if DB is empty AND direct fetch succeeds).
 *  4. Empty dict (last-resort degradation, logged as warning).
 */
export async function fetchLocaleNameMap(): Promise<Record<string, string>> {
  const now = Date.now();
  if (localeCache && localeCache.expiresAt > now) return localeCache.data;

  try {
    // Library validation runs in parallel with DB read.
    const library = await fetchLibrary().catch(() => ({} as Record<string, any>));
    const allItems: Record<string, any>    = (library as any).items    ?? {};
    const allEntities: Record<string, any> = (library as any).entities ?? {};

    // Try DB first (normal path after startup).
    const dbRows = getAllLocaleRows();
    if (dbRows.length > 0) {
      const raw: Record<string, string> = {};
      for (const { key, text } of dbRows) raw[key] = text;

      const { data, ambiguous, dropped } = buildNameMapFromRaw(raw, allItems, allEntities);
      localeCache = { data, expiresAt: now + CACHE_TTL_MS };
      console.log(
        `[fetchLocaleNameMap] built ${Object.keys(data).length} validated names from DB` +
        ` (${ambiguous} disambiguated, ${dropped} stale dropped, ${dbRows.length} raw rows)`,
      );
      return data;
    }

    // DB is empty — fall back to live fetch (first boot before seed completes).
    console.warn("[fetchLocaleNameMap] DB empty — falling back to live i18n fetch");
    const i18nUrl = `${PIXELS_SERVER}/v1/i18n/game/en?tenant=pixels`;
    const i18nRes = await fetch(i18nUrl, { headers: HEADERS });
    if (!i18nRes.ok) {
      console.warn(`[fetchLocaleNameMap] live fetch ${i18nRes.status} — returning empty map`);
      return localeCache?.data ?? {};
    }

    const raw = await i18nRes.json() as Record<string, string>;
    console.log(`[fetchLocaleNameMap] live fetch sample keys: ${Object.keys(raw).slice(0, 5).join(", ")}`);

    const { data, ambiguous, dropped } = buildNameMapFromRaw(raw, allItems, allEntities);
    localeCache = { data, expiresAt: now + CACHE_TTL_MS };
    console.log(
      `[fetchLocaleNameMap] loaded ${Object.keys(data).length} validated names from live fetch` +
      ` (${ambiguous} disambiguated, ${dropped} stale dropped)`,
    );
    return data;
  } catch (err) {
    console.warn(`[fetchLocaleNameMap] failed:`, err);
    return localeCache?.data ?? {};
  }
}
