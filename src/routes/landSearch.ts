import { Router, Request, Response } from "express";
import { db } from "../db/database";

const router = Router();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_LAND_TYPES = new Set(["space", "land", "water"]);
const TIER_RE = /^tier\d+$/;
const KNOWN_PARAMS = new Set([
  "landType",
  "tier",
  "ownerAddress",
  "hasIndustry",
  "limit",
  "offset",
]);
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// DB row shape returned by the JOIN query
// ---------------------------------------------------------------------------

interface LandJoinRow {
  land_id:         string;
  name:            string | null;
  owner_address:   string | null;
  land_type:       string | null;
  tiers_available: string;        // JSON string
  observed_at:     number | null; // null when no land_reports row exists
  industries:      string | null; // JSON string | null
}

// ---------------------------------------------------------------------------
// GET /api/lands/search
// ---------------------------------------------------------------------------

router.get("/api/lands/search", (req: Request, res: Response) => {
  // ---- Reject unknown query params ----------------------------------------
  const unknown = Object.keys(req.query).filter((k) => !KNOWN_PARAMS.has(k));
  if (unknown.length > 0) {
    res.status(400).json({ error: `Unknown query parameter(s): ${unknown.join(", ")}` });
    return;
  }

  // ---- Validate and coerce each param ------------------------------------

  const { landType, tier, ownerAddress, hasIndustry } = req.query;

  if (landType !== undefined) {
    if (typeof landType !== "string" || !VALID_LAND_TYPES.has(landType)) {
      res.status(400).json({ error: "landType must be one of: space, land, water" });
      return;
    }
  }

  if (tier !== undefined) {
    if (typeof tier !== "string" || !TIER_RE.test(tier)) {
      res
        .status(400)
        .json({ error: "tier must match pattern tier{n} e.g. tier2, tier5" });
      return;
    }
  }

  if (ownerAddress !== undefined && typeof ownerAddress !== "string") {
    res.status(400).json({ error: "ownerAddress must be a string" });
    return;
  }

  let filterHasIndustry = false;
  if (hasIndustry !== undefined) {
    if (hasIndustry !== "true" && hasIndustry !== "false") {
      res.status(400).json({ error: "hasIndustry must be 'true' or 'false'" });
      return;
    }
    filterHasIndustry = hasIndustry === "true";
  }

  const rawLimit  = req.query.limit  !== undefined ? parseInt(String(req.query.limit),  10) : DEFAULT_LIMIT;
  const rawOffset = req.query.offset !== undefined ? parseInt(String(req.query.offset), 10) : 0;

  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_LIMIT) {
    res.status(400).json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` });
    return;
  }
  if (!Number.isInteger(rawOffset) || rawOffset < 0) {
    res.status(400).json({ error: "offset must be a non-negative integer" });
    return;
  }

  // ---- Build dynamic WHERE clause ----------------------------------------

  const conditions: string[] = [];
  const bindParams: (string | number)[] = [];

  if (typeof landType === "string") {
    conditions.push("lp.land_type = ?");
    bindParams.push(landType);
  }
  if (typeof ownerAddress === "string") {
    conditions.push("lp.owner_address = ?");
    bindParams.push(ownerAddress);
  }
  if (typeof tier === "string") {
    // json_each lets SQLite iterate the stored JSON array without pulling the
    // whole row into application code for filtering.
    conditions.push(
      "EXISTS (SELECT 1 FROM json_each(lp.tiers_available) WHERE value = ?)"
    );
    bindParams.push(tier);
  }
  if (filterHasIndustry) {
    // Turning the LEFT JOIN into an effective INNER JOIN for this filter.
    // Lands without a land_reports row are excluded rather than returned with
    // a null industryReport — the caller asked for only lands with coverage.
    conditions.push("lr.land_id IS NOT NULL");
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  // ---- Count total matching rows (for pagination metadata) ---------------

  const countSql = `
    SELECT COUNT(*) AS total
    FROM land_placements lp
    LEFT JOIN land_reports lr ON lr.land_id = lp.land_id
    ${where}
  `;
  const countRow = db
    .prepare<unknown[]>(countSql)
    .get(...bindParams) as { total: number } | undefined;
  const total = countRow?.total ?? 0;

  // ---- Fetch one page of results -----------------------------------------

  const selectSql = `
    SELECT
      lp.land_id,
      lp.name,
      lp.owner_address,
      lp.land_type,
      lp.tiers_available,
      lr.observed_at,
      lr.industries
    FROM land_placements lp
    LEFT JOIN land_reports lr ON lr.land_id = lp.land_id
    ${where}
    ORDER BY lp.land_id
    LIMIT ? OFFSET ?
  `;
  const rows = db
    .prepare<unknown[]>(selectSql)
    .all(...bindParams, rawLimit, rawOffset) as LandJoinRow[];

  // ---- Shape each row into the API response ------------------------------

  const results = rows.map((row) => {
    let tiersAvailable: string[] = [];
    try {
      tiersAvailable = JSON.parse(row.tiers_available) ?? [];
    } catch {
      /* leave as [] — malformed JSON should never reach here */
    }

    // industryReport is null when no extension user has visited this land yet.
    // lastObserved is the epoch ms when a player's extension last observed the
    // land's live room state — it is NOT a live or full-map snapshot.
    let industryReport: {
      reportedIndustries: unknown[];
      lastObserved: number;
    } | null = null;

    if (row.observed_at !== null && row.industries !== null) {
      let reportedIndustries: unknown[] = [];
      try {
        reportedIndustries = JSON.parse(row.industries) ?? [];
      } catch {
        /* leave as [] */
      }
      industryReport = {
        reportedIndustries,
        lastObserved: row.observed_at,
      };
    }

    return {
      landId:        row.land_id,
      name:          row.name,
      ownerAddress:  row.owner_address,
      landType:      row.land_type,
      tiersAvailable,
      industryReport,
    };
  });

  res.json({ total, limit: rawLimit, offset: rawOffset, results });
});

export default router;
