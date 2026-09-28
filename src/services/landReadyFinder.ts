import { db } from "../db/database";

// ---------------------------------------------------------------------------
// Industry → entity string pattern map
// Entity strings stored in land_placements.entities look like:
//   "mine_t3", "woodwork_t2", "farm_soil_t1", "cook_t2", "stone_t1",
//   "fish_t1", "metal_t2", "animalcare_t1", "boost_production", etc.
// ---------------------------------------------------------------------------

export const INDUSTRY_ENTITY_MAP: Record<string, string> = {
  mine:         "mine",
  mining:       "mine",
  woodwork:     "woodwork",
  woodworking:  "woodwork",
  forestry:     "woodwork",
  chop:         "woodwork",
  chopping:     "woodwork",
  farm:         "farm",
  farming:      "farm",
  cook:         "cook",
  cooking:      "cook",
  stoneshaping: "stone",
  stone:        "stone",
  fish:         "fish",
  fishing:      "fish",
  metalwork:    "metal",
  metalworking: "metal",
  animalcare:   "animal",
  animal:       "animal",
};

// Maps "soil" → "land" for land_type column values
const LAND_TYPE_ALIASES: Record<string, string> = {
  soil:  "land",
  grass: "land",
  land:  "land",
  water: "water",
  space: "space",
};

export function resolveIndustry(raw: string): string | null {
  return INDUSTRY_ENTITY_MAP[raw.toLowerCase().trim()] ?? null;
}

export function resolveLandType(raw: string): string | null {
  return LAND_TYPE_ALIASES[raw.toLowerCase().trim()] ?? null;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ReadyLand {
  landId:          string;
  landNumber:      string;
  name:            string | null;
  landType:        string | null;
  tiersAvailable:  string[];
  entityMatches:   string[];
  boosts:          string[];
  isPublic:        boolean;
  permissionsUse:  string[];
  lastCrawled:     number;
  spotCount:       number;    // count from crawl index
  available:       number;    // confirmed from live check (= spotCount when liveChecked=false)
  liveChecked:     boolean;
}

// ---------------------------------------------------------------------------
// In-memory caches + per-player throttle
// ---------------------------------------------------------------------------

const resultCache    = new Map<string, { result: ReadyLand[]; cachedAt: number }>();
const liveCache      = new Map<string, { available: number; total: number; checkedAt: number }>();
const playerThrottle = new Map<string, number>();

export const CACHE_TTL_MS    = 60_000;   // 60 s (both result cache and live cache)
export const THROTTLE_MS     = 30_000;   // 30 s per player
const MAX_CANDIDATES         = 200;      // DB rows to consider
const LIVE_BATCH_SIZE        = 8;        // parallel requests per batch
const MAX_LIVE_CHECKS        = 60;       // hard cap on live requests per search

// Pixels server base URL — same env var used by crawler
const PIXELS_SERVER =
  process.env.PIXELS_SERVER_URL?.replace(/\/$/, "") ??
  "https://pixels-server.pixels.xyz";

const BROWSER_HEADERS = {
  Origin:       "https://play.pixels.xyz",
  Referer:      "https://play.pixels.xyz/",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

// ---------------------------------------------------------------------------
// Throttle helpers
// ---------------------------------------------------------------------------

export function isPlayerThrottled(playerKey: string): boolean {
  const last = playerThrottle.get(playerKey) ?? 0;
  return Date.now() - last < THROTTLE_MS;
}

export function recordPlayerSearch(playerKey: string): void {
  playerThrottle.set(playerKey, Date.now());
}

export function getThrottleSecondsLeft(playerKey: string): number {
  const last = playerThrottle.get(playerKey) ?? 0;
  return Math.max(0, Math.ceil((last + THROTTLE_MS - Date.now()) / 1000));
}

// ---------------------------------------------------------------------------
// Live entity count fetch
// Calls farm_details to get the current entity list for a land.
// Returns { available, total } where available = total = count of matching
// entities (farm_details shows placements, not real-time lock state; a land
// with N entities placed has N spots you can start using).
// Returns null on any error — caller falls back to crawl-index count.
// ---------------------------------------------------------------------------

async function fetchLiveCount(farmId: string, industryPattern: string): Promise<{ available: number; total: number } | null> {
  const cached = liveCache.get(farmId);
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return { available: cached.available, total: cached.total };
  }

  try {
    const url = `${PIXELS_SERVER}/v1/infiniportal/farm_details/${farmId}`;
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    const data = await res.json() as { entities?: { id: string; world: number; entity: string }[] };
    const entities = Array.isArray(data?.entities) ? data.entities : [];
    const matching = entities.filter(e =>
      typeof e.entity === "string" && e.entity.toLowerCase().includes(industryPattern.toLowerCase())
    );
    const count = matching.length;
    liveCache.set(farmId, { available: count, total: count, checkedAt: Date.now() });
    return { available: count, total: count };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main finder
// ---------------------------------------------------------------------------

interface LandRow {
  land_id:         string;
  name:            string | null;
  land_type:       string | null;
  tiers_available: string;
  entities:        string;
  permissions_use: string;
  last_crawled:    number;
}

export async function findReadyLands(params: {
  industry:     string;         // entity pattern, e.g. "mine"
  tier?:        number;         // e.g. 3 → filter tiers_available contains "tier3"
  landType?:    string;         // "water", "land", "space"
  guildHandle?: string;
  limit?:       number;
}): Promise<ReadyLand[]> {
  const { industry, tier, landType, guildHandle, limit = 8 } = params;
  const cacheKey = `${industry}:${tier ?? ""}:${landType ?? ""}:${guildHandle ?? ""}`;

  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.result.slice(0, limit);
  }

  // Build DB query
  const conditions: string[] = [];
  const bindParams: (string | number)[] = [];

  conditions.push(`EXISTS (SELECT 1 FROM json_each(lp.entities) WHERE value LIKE ?)`);
  bindParams.push(`%${industry}%`);

  if (tier !== undefined) {
    // Tier is embedded in entity strings (e.g. "mine_t3"), not reliably in tiers_available.
    conditions.push(`EXISTS (SELECT 1 FROM json_each(lp.entities) WHERE value GLOB ?)`);
    bindParams.push(`*_t${tier}`);
  }

  if (landType) {
    conditions.push("lp.land_type = ?");
    bindParams.push(landType);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;

  const rows = db.prepare<unknown[]>(`
    SELECT land_id, name, land_type, tiers_available, entities, permissions_use, last_crawled
    FROM land_placements lp
    ${where}
    ORDER BY lp.last_crawled DESC
    LIMIT ?
  `).all(...bindParams, MAX_CANDIDATES) as LandRow[];

  // Build candidate list (public lands with entity matches)
  const candidates: ReadyLand[] = rows
    .map(row => {
      const tiersAvailable: string[] = safeJsonArray(row.tiers_available);
      const entities: string[]       = safeJsonArray(row.entities);
      const permissionsUse: string[] = safeJsonArray(row.permissions_use);

      const entityMatches = entities.filter(e =>
        e.toLowerCase().includes(industry.toLowerCase())
      );
      const boosts = entities.filter(e =>
        e.toLowerCase().includes("boost") ||
        e.toLowerCase().includes("speed") ||
        e.toLowerCase().includes("yield") ||
        e.toLowerCase().includes("production")
      );
      const isPublic = isLandPublic(permissionsUse, guildHandle);

      return {
        landId:         row.land_id,
        landNumber:     row.land_id.replace(/^pixelsNFTFarm-/, ""),
        name:           row.name,
        landType:       row.land_type,
        tiersAvailable,
        entityMatches,
        boosts,
        isPublic,
        permissionsUse,
        lastCrawled:    row.last_crawled,
        spotCount:      entityMatches.length,
        available:      entityMatches.length,  // will be updated from live check
        liveChecked:    false,
      };
    })
    .filter(l => l.isPublic && l.entityMatches.length > 0)
    .sort((a, b) => {
      if (b.spotCount !== a.spotCount) return b.spotCount - a.spotCount;
      if (b.boosts.length !== a.boosts.length) return b.boosts.length - a.boosts.length;
      return a.landNumber.localeCompare(b.landNumber, undefined, { numeric: true });
    });

  // ---------------------------------------------------------------------------
  // Live check: fetch current entity counts in parallel batches of 8.
  // Stop early when 8 available lands found OR 60 total checks done.
  // ---------------------------------------------------------------------------
  const confirmed: ReadyLand[] = [];
  let totalChecked = 0;

  for (let i = 0; i < candidates.length && confirmed.length < limit && totalChecked < MAX_LIVE_CHECKS; i += LIVE_BATCH_SIZE) {
    const batch = candidates.slice(i, i + LIVE_BATCH_SIZE);
    totalChecked += batch.length;

    const results = await Promise.all(
      batch.map(land => fetchLiveCount(land.landId, industry).then(r => ({ land, liveResult: r })))
    );

    for (const { land, liveResult } of results) {
      if (liveResult === null) continue; // live check failed — exclude this land
      land.available   = liveResult.available;
      land.liveChecked = true;
      if (land.available > 0) {
        confirmed.push(land);
      }
      if (confirmed.length >= limit) break;
    }
  }

  // Sort confirmed: available DESC, then boosted first, then land number
  confirmed.sort((a, b) => {
    if (b.available !== a.available) return b.available - a.available;
    if (b.boosts.length !== a.boosts.length) return b.boosts.length - a.boosts.length;
    return a.landNumber.localeCompare(b.landNumber, undefined, { numeric: true });
  });

  resultCache.set(cacheKey, { result: confirmed, cachedAt: Date.now() });
  return confirmed.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as unknown[]).map(String) : [];
  } catch {
    return [];
  }
}

function isLandPublic(permissionsUse: string[], guildHandle?: string): boolean {
  if (permissionsUse.length === 0) return true;
  for (const p of permissionsUse) {
    const lower = p.toLowerCase();
    if (lower === "public" || lower === "everyone" || lower === "all" || lower === "open") {
      return true;
    }
    if (guildHandle && lower.includes(guildHandle.toLowerCase())) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Text formatter for chat answers
// ---------------------------------------------------------------------------

export function formatReadyLandsAnswer(params: {
  lands:          ReadyLand[];
  industry:       string;     // raw user-facing industry name e.g. "mine", "woodwork"
  tier?:          number;
  landType?:      string;
  totalInDB:      number;
}): string {
  const { lands, industry, tier, landType, totalInDB } = params;
  const tierLabel     = tier     ? ` tier ${tier}` : "";
  const typeLabel     = landType ? ` on ${landType} land` : "";
  const industryLabel = industry.charAt(0).toUpperCase() + industry.slice(1);
  const liveChecked   = lands.some(l => l.liveChecked);

  if (lands.length === 0) {
    return (
      `No public lands with ${industryLabel}${tierLabel} industries${typeLabel} found right now. ` +
      `The crawler covers ~5,000 lands; try broadening your search (e.g. remove the land type filter).`
    );
  }

  const header = liveChecked
    ? `Public lands with ${industryLabel}${tierLabel} available${typeLabel} — top ${lands.length} from ${totalInDB} indexed:`
    : `Public lands with ${industryLabel}${tierLabel} industries${typeLabel} — top ${lands.length} from ${totalInDB} indexed:`;
  const lines: string[] = [header];

  for (let i = 0; i < lands.length; i++) {
    const l = lands[i];
    const num  = l.landNumber;
    const type = l.landType ? ` (${l.landType})` : "";

    let availStr: string;
    if (l.liveChecked) {
      availStr = `${l.available}/${l.spotCount} ${industryLabel.toLowerCase()} spots available`;
    } else {
      availStr = `${l.spotCount} ${industryLabel.toLowerCase()} spot${l.spotCount !== 1 ? "s" : ""}`;
    }

    const boostNames = l.boosts.slice(0, 2).map(b =>
      b.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())
    );
    const boostNote = boostNames.length > 0 ? ` · boost: ${boostNames.join(", ")}` : "";
    const tierList  = l.tiersAvailable.length > 0 ? ` [${l.tiersAvailable.join(", ")}]` : "";

    lines.push(`${i + 1}. Land ${num}${type}${tierList} — ${availStr}${boostNote}`);
  }

  lines.push(`\nVisit any land: enter farm code pixelsNFTFarm-<number> in the game.`);

  return lines.join("\n");
}
