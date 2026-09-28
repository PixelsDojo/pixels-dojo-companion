import { Router, Request, Response } from "express";
import { db } from "../db/database";
import {
  findReadyLands, resolveIndustry, resolveLandType,
  isPlayerThrottled, recordPlayerSearch, getThrottleSecondsLeft,
  THROTTLE_MS, CACHE_TTL_MS,
} from "../services/landReadyFinder";

const router = Router();

const VALID_LAND_TYPES = new Set(["water", "land", "space", "soil", "grass"]);

// GET /api/lands/ready
// Query params:
//   industry  — required: "mine", "mining", "woodwork", "farm", "cook", "stone", "fish"
//   tier      — optional: integer e.g. 3
//   landType  — optional: "water" | "land" | "space" | "soil" (soil maps to land)
//   playerKey — optional: wallet/playerId for throttle tracking (no PII stored)
//   limit     — optional: 1–20, default 8
router.get("/api/lands/ready", async (req: Request, res: Response) => {
  const { industry: rawIndustry, tier: rawTier, landType: rawLandType, playerKey, limit: rawLimit } = req.query;

  if (!rawIndustry || typeof rawIndustry !== "string") {
    res.status(400).json({ error: "industry is required (e.g. mine, woodwork, farm, cook, stone, fish)" });
    return;
  }

  const industry = resolveIndustry(rawIndustry);
  if (!industry) {
    res.status(400).json({
      error: `Unknown industry "${rawIndustry}". Valid values: mine/mining, woodwork/forestry/chop, farm/farming, cook/cooking, stoneshaping/stone, fish/fishing, metalwork, animalcare`,
    });
    return;
  }

  let tier: number | undefined;
  if (rawTier !== undefined) {
    tier = parseInt(String(rawTier), 10);
    if (!Number.isInteger(tier) || tier < 1 || tier > 10) {
      res.status(400).json({ error: "tier must be an integer 1–10" });
      return;
    }
  }

  let landType: string | undefined;
  if (rawLandType !== undefined) {
    if (typeof rawLandType !== "string" || !VALID_LAND_TYPES.has(rawLandType.toLowerCase())) {
      res.status(400).json({ error: "landType must be one of: water, land, space, soil" });
      return;
    }
    landType = resolveLandType(rawLandType) ?? undefined;
  }

  const limit = rawLimit !== undefined
    ? Math.min(20, Math.max(1, parseInt(String(rawLimit), 10) || 8))
    : 8;

  // Per-player throttle
  const pkey = typeof playerKey === "string" && playerKey.length > 0 ? playerKey : null;
  if (pkey && isPlayerThrottled(pkey)) {
    const secs = getThrottleSecondsLeft(pkey);
    res.status(429).json({
      error: `Search throttled — please wait ${secs}s before searching again.`,
      retryAfterSeconds: secs,
    });
    return;
  }
  if (pkey) recordPlayerSearch(pkey);

  try {
    // Count total DB candidates for the response metadata
    const conditions: string[] = [
      `EXISTS (SELECT 1 FROM json_each(entities) WHERE value LIKE ?)`,
    ];
    const bindParams: (string | number)[] = [`%${industry}%`];

    if (tier !== undefined) {
      conditions.push(`EXISTS (SELECT 1 FROM json_each(entities) WHERE value GLOB ?)`);
      bindParams.push(`*_t${tier}`);
    }
    if (landType) {
      conditions.push("land_type = ?");
      bindParams.push(landType);
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const countRow = db.prepare<unknown[]>(
      `SELECT COUNT(*) as total FROM land_placements ${where}`
    ).get(...bindParams) as { total: number } | undefined;
    const totalInDB = countRow?.total ?? 0;

    const lands = await findReadyLands({ industry, tier, landType, limit });

    res.json({
      industry: rawIndustry,
      tier:     tier ?? null,
      landType: landType ?? null,
      total:    totalInDB,
      count:    lands.length,
      cacheTtlSeconds: CACHE_TTL_MS / 1000,
      throttleSeconds: THROTTLE_MS / 1000,
      lands,
    });
  } catch (err) {
    console.error("[landReady] error:", err);
    res.status(500).json({ error: "Internal error searching lands" });
  }
});

// GET /debug/lands?key=<debug_key>&land=<land_number>
// Shows the full decision trail for one land: DB row, live check, filter reasons.
// Protected by DEBUG_KEY env var (default "dev").
router.get("/debug/lands", async (req: Request, res: Response) => {
  const debugKey = process.env.DEBUG_KEY ?? "";
  if (!debugKey || req.query.key !== debugKey) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }

  const rawLand = req.query.land;
  if (!rawLand || typeof rawLand !== "string") {
    res.status(400).json({ error: "land param required (numeric land ID)" });
    return;
  }

  const landId = rawLand.startsWith("pixelsNFTFarm-")
    ? rawLand
    : `pixelsNFTFarm-${rawLand}`;

  type LandDebugRow = {
    land_id: string; name: string | null; land_type: string | null;
    tiers_available: string; entities: string; permissions_use: string; last_crawled: number;
  };

  const row = db.prepare<unknown[]>(
    `SELECT land_id, name, land_type, tiers_available, entities, permissions_use, last_crawled
     FROM land_placements WHERE land_id = ?`
  ).get(landId) as LandDebugRow | undefined;

  if (!row) {
    res.json({ landId, inDB: false, note: "Land not found in crawl index" });
    return;
  }

  const parseArr = (s: string): string[] => {
    try { const p = JSON.parse(s); return Array.isArray(p) ? p.map(String) : []; } catch { return []; }
  };

  const entities       = parseArr(row.entities);
  const tiersAvailable = parseArr(row.tiers_available);
  const permissionsUse = parseArr(row.permissions_use);

  // Live check
  const PIXELS_SERVER = (process.env.PIXELS_SERVER_URL ?? "https://pixels-server.pixels.xyz").replace(/\/$/, "");
  const BROWSER_HEADERS = {
    Origin: "https://play.pixels.xyz", Referer: "https://play.pixels.xyz/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  };

  let liveData: unknown = null;
  let liveError: string | null = null;
  try {
    const liveUrl = `${PIXELS_SERVER}/v1/infiniportal/farm_details/${landId}`;
    const liveRes = await fetch(liveUrl, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(10_000) });
    if (liveRes.ok) {
      liveData = await liveRes.json();
    } else {
      liveError = `HTTP ${liveRes.status}`;
    }
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
  }

  // Filter checks for common query params
  const industry = typeof req.query.industry === "string" ? req.query.industry : null;
  const tier = typeof req.query.tier === "string" ? parseInt(req.query.tier, 10) : null;
  const landType = typeof req.query.landType === "string" ? req.query.landType : null;

  const filterChecks: Record<string, unknown> = {
    land_type_in_db:    row.land_type,
    tiers_available:    tiersAvailable,
    entities_count:     entities.length,
    entities_sample:    entities.slice(0, 20),
    permissions_use:    permissionsUse,
    age_minutes:        Math.round((Date.now() - row.last_crawled) / 60_000),
  };

  if (industry) {
    const entityMatches = entities.filter(e => e.toLowerCase().includes(industry.toLowerCase()));
    filterChecks.industry_filter = { industry, entityMatches, pass: entityMatches.length > 0 };
  }
  if (tier !== null && !isNaN(tier)) {
    const tierSuffix = `_t${tier}`;
    const tierMatches = entities.filter(e => e.endsWith(tierSuffix));
    filterChecks.tier_filter = { tier, tierSuffix, tierMatches, pass: tierMatches.length > 0 };
  }
  if (landType) {
    filterChecks.land_type_filter = { required: landType, actual: row.land_type, pass: row.land_type === landType };
  }

  const isPublic = permissionsUse.length === 0 ||
    permissionsUse.some(p => ["public","everyone","all","open"].includes(p.toLowerCase()));
  filterChecks.is_public = isPublic;

  res.json({
    landId,
    inDB: true,
    dbRow: { ...row, entities_parsed: entities, tiers_available_parsed: tiersAvailable, permissions_use_parsed: permissionsUse },
    filterChecks,
    liveData: liveData ?? null,
    liveError: liveError ?? null,
  });
});

export default router;
