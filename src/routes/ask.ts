import { Router, Request, Response } from "express";
import { db, CatalogRow, WikiEntry, getUpcomingThresholds, listActiveGoals, runDailyDiary, insertShoppingItem, listShoppingItems, deleteShoppingItem, recordTaskboardEvent, insertNotebookGoal, listNotebookGoals, deleteNotebookGoal, updateNotebookGoal, listAllTips, listGuides, upsertActivityTimer, listActivityTimers, markActivityTimerCollected, deleteActivityTimer, getPlayerOwnedLandType, upsertPlayerStorage, getPlayerStorage, PlayerStorageChest, getPlayerPrefs, setPlayerPref } from "../db/database";
import { askLLM, LLMUnavailableError, getLastUsedModel, resetLastUsedModel } from "../services/llm";
import { fetchItems, fetchAchievements, fetchLocaleNameMap } from "../services/gameLibrary";
import { computeCraftEfficiency } from "./craftEfficiency";
import { computeBestActions, BestActionsResult } from "../services/strategy";
import { findItemsInQuestion, formatItemDataSection, resolveItemName, computeCraftingBreakdown, formatCraftingMathSection, buildHarvestMap, RecursiveLeaf } from "../services/itemLookup";
import { computeResourceAccess } from "../services/resourceAccess";
import { fetchEntities } from "../services/gameLibrary";
import { getCatalogRow, countCatalogRows, getMarketPrice, getCatalogRowsByDisplayName } from "../db/database";
import { generateFastAnswer, fuzzyResolveName, fuzzyResolveNameStrict, queryCatalog, rebuildCatalogIfNeeded } from "../services/gameCatalog";
import { computeCoinStrategy } from "../services/coinStrategy";
import { rephraseWithValidation } from "../services/rephraseValidator";
import { findReadyLands, resolveIndustry, resolveLandType, formatReadyLandsAnswer, isPlayerThrottled, recordPlayerSearch, getThrottleSecondsLeft } from "../services/landReadyFinder";

const router = Router();

// Per-player pending land-query memory for follow-up replies (lost on restart)
const pendingLandQueryMap = new Map<string, { timestamp: number }>();
const PENDING_LAND_QUERY_TTL = 5 * 60_000; // 5 minutes

// Per-player last-item context for cost/follow-up questions (lost on restart)
const lastItemContextMap = new Map<string, { itemId: string; displayName: string; ingredients?: Array<{name: string; qty: number}>; timestamp: number }>();
const LAST_ITEM_TTL = 15 * 60_000; // 15 minutes

// Per-player candidate list context for "how much do they cost" follow-ups (lost on restart)
const lastCandidateListMap = new Map<string, { items: Array<{itemId: string; displayName: string}>; staticAnswer?: string; timestamp: number }>();
const LAST_CANDIDATE_TTL = 15 * 60_000; // 15 minutes

// Per-player last taskboard list answer for "pls list them" / "show me" follow-ups
const lastTaskboardAnswerMap = new Map<string, { answer: string; timestamp: number }>();
const LAST_TASKBOARD_TTL = 15 * 60_000; // 15 minutes

// ---------------------------------------------------------------------------
// Single-source taskboard + stacked resolver
// Live data wins. Falls back to in-memory cache, then backend snapshot.
// Taskboard cache is valid the same UTC day; stacked offers filter expired rows.
// ---------------------------------------------------------------------------

const taskboardCacheMap = new Map<string, { orders: any[]; capturedAt: number }>();
const stackedCacheMap   = new Map<string, { offers: any[]; capturedAt: number }>();

function isSameUtcDay(msA: number, msB: number): boolean {
  return new Date(msA).toISOString().slice(0, 10) === new Date(msB).toISOString().slice(0, 10);
}

function resolveTaskboard(p: any, pid: string | null): { orders: any[]; source: "live" | "cache" | "none" } {
  const live: any[] = Array.isArray(p?.taskboard) ? (p.taskboard as any[]) : [];
  if (live.length > 0) {
    if (pid) {
      taskboardCacheMap.set(pid, { orders: live, capturedAt: Date.now() });
      try { setPlayerPref(pid, "taskboardSnapshot", { orders: live, capturedAt: Date.now() }); } catch { /* db */ }
    }
    return { orders: live, source: "live" };
  }
  if (pid) {
    const mem = taskboardCacheMap.get(pid);
    if (mem && isSameUtcDay(mem.capturedAt, Date.now())) return { orders: mem.orders, source: "cache" };
    try {
      const snap = getPlayerPrefs(pid).taskboardSnapshot as any;
      if (snap?.orders?.length > 0 && isSameUtcDay(snap.capturedAt, Date.now())) {
        taskboardCacheMap.set(pid, { orders: snap.orders, capturedAt: snap.capturedAt });
        return { orders: snap.orders, source: "cache" };
      }
    } catch { /* db */ }
  }
  return { orders: [], source: "none" };
}

function resolveStacked(p: any, pid: string | null): { offers: any[]; source: "live" | "cache" | "none" } {
  const live: any[] = Array.isArray(p?.stackedOffers) ? (p.stackedOffers as any[]) : [];
  if (live.length > 0) {
    if (pid) {
      stackedCacheMap.set(pid, { offers: live, capturedAt: Date.now() });
      try { setPlayerPref(pid, "stackedSnapshot", { offers: live, capturedAt: Date.now() }); } catch { /* db */ }
    }
    return { offers: live, source: "live" };
  }
  const now = Date.now();
  if (pid) {
    const mem = stackedCacheMap.get(pid);
    if (mem) {
      const valid = mem.offers.filter((o: any) => typeof o.expiresAt !== "number" || o.expiresAt > now);
      if (valid.length > 0) return { offers: valid, source: "cache" };
    }
    try {
      const snap = getPlayerPrefs(pid).stackedSnapshot as any;
      if (snap?.offers?.length > 0) {
        const valid = snap.offers.filter((o: any) => typeof o.expiresAt !== "number" || o.expiresAt > now);
        if (valid.length > 0) {
          stackedCacheMap.set(pid, { offers: valid, capturedAt: snap.capturedAt });
          return { offers: valid, source: "cache" };
        }
      }
    } catch { /* db */ }
  }
  return { offers: [], source: "none" };
}

// ---------------------------------------------------------------------------
// Taskboard helpers — shared by FIRST, TOP, LIST routes
// ---------------------------------------------------------------------------

// Resolve order itemId: extension-provided if valid, then exact display-name DB lookup,
// then fuzzy fallback (max dist 1). Exact match is tried first because fuzzyResolveName's
// word-level scoring can match a query word like "Glass" against a longer name like
// "Adamaxium Magnifying Glass" at distance 0, picking the wrong item.
function resolveTaskboardItemId(order: any): string | null {
  if (typeof order.itemId === "string" && order.itemId.startsWith("itm_")) return order.itemId;
  if (typeof order.itemName === "string" && order.itemName.trim()) {
    const name = order.itemName.trim();
    // 1. Exact case-insensitive display name match
    const exact = getCatalogRowsByDisplayName(name);
    if (exact.length > 0) return exact[0].item_id;
    // 2. Strict full-name fuzzy fallback (max dist 1, no word-level bonus) — catches typos
    //    without matching "Glass" to "Adamaxium Magnifying Glass" or "Clover Fruit" to "Clover Fruit Jam"
    const m1 = fuzzyResolveNameStrict(name, 1);
    if (m1) return m1.itemId;
  }
  return null;
}

// Fill cost using DB market price (sync) with fallback to extension-captured prices.
// When market volume < stillNeed, returns partial=true so callers can show "~" warning.
function resolveOrderFillCost(
  itemId: string | null,
  stillNeed: number,
  playerMp: Record<string, { lowestPrice: number; quantity: number }>,
): { cost: number | null; source: string; ageMin?: number; partial?: boolean; marketVolume?: number } {
  if (stillNeed <= 0) return { cost: 0, source: "ready" };
  if (!itemId) return { cost: null, source: "unknown" };
  const dbMp = getMarketPrice(itemId);
  if (dbMp && dbMp.min_price > 0) {
    const ageMin = Math.round((Date.now() - dbMp.updated_at) / 60_000);
    if (dbMp.volume > 0 && dbMp.volume < stillNeed) {
      // Market can't cover the full order — estimate using avg_price for what's listed
      const partialCost = Math.round(dbMp.volume * (dbMp.avg_price > 0 ? dbMp.avg_price : dbMp.min_price));
      return { cost: partialCost, source: "db", ageMin, partial: true, marketVolume: dbMp.volume };
    }
    return { cost: stillNeed * dbMp.min_price, source: "db", ageMin };
  }
  const pMp = playerMp[itemId];
  if (pMp && pMp.lowestPrice > 0) return { cost: stillNeed * pMp.lowestPrice, source: "cached" };
  return { cost: null, source: "unknown" };
}

// Estimate craft cost for `qty` of `itemId`, with held items counted free.
// Goes up to maxDepth levels deep (ingredients of ingredients).
// Returns null if item has no recipe; canCraft=false if a price is missing.
function estimateCraftCost(
  itemId: string,
  qty: number,
  allHeld: Record<string, number>,
  visited: Set<string> = new Set(),
  depth: number = 0,
  maxDepth: number = 2,
): { cost: number; energy: number; canCraft: boolean } | null {
  if (visited.has(itemId)) return null;
  const row = getCatalogRow(itemId);
  if (!row || !row.recipe_inputs) return null;
  let inputs: Array<{ id: string; name: string; qty: number }>;
  try { inputs = JSON.parse(row.recipe_inputs); } catch { return null; }
  if (!inputs || inputs.length === 0) return null;

  const outputQty = row.recipe_output_qty ?? 1;
  const runs = Math.ceil(qty / outputQty);
  const baseEnergy = (row.craft_energy ?? 0) * runs;

  const childVisited = new Set(visited);
  childVisited.add(itemId);

  let totalCost = 0;
  let canCraft = true;

  for (const ing of inputs) {
    const totalNeeded = ing.qty * runs;
    const have = allHeld[ing.id] ?? 0;
    const stillNeed = Math.max(0, totalNeeded - have);
    if (stillNeed === 0) continue;

    let covered = false;
    if (depth < maxDepth) {
      const sub = estimateCraftCost(ing.id, stillNeed, allHeld, childVisited, depth + 1, maxDepth);
      if (sub !== null && sub.canCraft) {
        totalCost += sub.cost;
        covered = true;
      }
    }
    if (!covered) {
      const mp = getMarketPrice(ing.id);
      if (mp && mp.min_price > 0) {
        totalCost += stillNeed * mp.min_price;
      } else {
        canCraft = false;
      }
    }
  }

  return { cost: totalCost, energy: baseEnergy, canCraft };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MarketPriceStat {
  minPrice: number;
  avgPrice: number;
  maxPrice: number;
  volume: number;
  currency: string;
}

interface AskContext {
  player?: {
    playerId?: unknown;
    energy?: unknown;
    // Extension sends 'coins' ({currencyId: balance}); legacy alias: coinInventory
    coins?: unknown;
    coinInventory?: unknown;
    // Extension sends 'skills' ({skillName: {level, totalExp}}); legacy alias: levels
    skills?: unknown;
    levels?: unknown;
    trustScore?: unknown;
    createdAt?: unknown;
    memberships?: unknown;
    // Live snapshots from injected.js pollers
    inventory?: unknown;
    taskboard?: unknown;
    stackedOffers?: unknown;
    // Guild + faction — from GPlayerCore via injected.js
    guildHandle?: unknown;
    guildRole?: unknown;
    faction?: unknown;
    factionId?: unknown;
    vipActive?: unknown;
    vipTier?: unknown;
    feeRate?: unknown;    // current marketplace fee rate as a decimal (e.g. 0.0085 = 0.85%)
    energyMax?: unknown;  // 1000 base + VIP bonus; sent alongside energy
    taskboardCapturedAt?: unknown;    // ms timestamp of last live taskboard read
    taskboardExpiresAt?: unknown;     // ms timestamp when taskboard refreshes
    stackedOffersCapturedAt?: unknown; // ms timestamp of last live stacked read
    _authToken?: unknown;             // game session token (kept for backend fallback)
    marketPrices?: unknown;           // { itemId: {lowestPrice, quantity} } — extension-fetched
    storageChests?: unknown;          // { [mid]: { items: [{itemId, qty}], size, capturedAt } }
    activityTimers?: unknown;         // [{entityMid,entityLabel,itemLabel,landLabel,mapId,startedAt,readyAt}]
    hearthHallSeasonStart?: unknown;  // ms timestamp when current Bountyfall/Hearth Hall season started
    buoyBucks?: unknown;              // player's current Buoy Bucks balance
  };
  nearbyEntities?: unknown[];
  marketPrices?: Record<string, MarketPriceStat>;
  goals?: unknown;
  sociabilityLevel?: unknown;
  timezone?: unknown;
  persona?: unknown;
  walletAddress?: unknown;
  cryptoWallets?: unknown;
  profile?: unknown;  // player profile {playStyle,goal,goalTarget,hasPet,storage,taskboardMaxPrice,taskboardTooExpensive}
}

// ---------------------------------------------------------------------------
// Keyword extraction + wiki search
// ---------------------------------------------------------------------------

function extractKeywords(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length >= 3);
  return [...new Set(words)];
}

function searchWiki(keywords: string[]): WikiEntry[] {
  if (keywords.length === 0) return [];
  const clauses = keywords.map(() => "(topic LIKE ? OR content LIKE ?)").join(" OR ");
  const params = keywords.flatMap((kw) => [`%${kw}%`, `%${kw}%`]);
  const matches = db
    .prepare<unknown[], WikiEntry>(`SELECT * FROM wiki_entries WHERE ${clauses}`)
    .all(...params);

  // Score by number of matching keywords; return top 2 most relevant.
  const scored = matches.map((entry) => {
    const haystack = `${entry.topic} ${entry.content}`.toLowerCase();
    const score = keywords.filter((kw) => haystack.includes(kw)).length;
    return { entry, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 2).map(({ entry }) => entry);
}

// ---------------------------------------------------------------------------
// Context formatting helpers
// ---------------------------------------------------------------------------

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function formatEnergy(energy: unknown, energyMax?: unknown): string | null {
  // Extension sends energy as a plain number; energyMax is a separate field.
  if (typeof energy === "number" && Number.isFinite(energy)) {
    const max = numOrNull(energyMax);
    return max !== null ? `Energy: ${energy}/${max}` : `Energy: ${energy}`;
  }
  // Legacy: handle old {current/level, max} shape.
  if (!energy || typeof energy !== "object") return null;
  const e = energy as Record<string, unknown>;
  const cur = numOrNull(e.current ?? e.level);
  const max = numOrNull(energyMax) ?? numOrNull(e.max);
  if (cur === null) return null;
  return max !== null ? `Energy: ${cur}/${max}` : `Energy: ${cur}`;
}

function formatCoinInventory(inv: unknown): string | null {
  if (!inv || typeof inv !== "object") return null;
  const lines: string[] = [];
  for (const [id, val] of Object.entries(inv as Record<string, unknown>)) {
    let balance: number | null = null;
    if (typeof val === "number") balance = val;
    else if (val && typeof val === "object")
      balance = numOrNull((val as Record<string, unknown>).balance);
    if (balance !== null && balance > 0) {
      const label = id
        .replace(/([A-Z])/g, " $1")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase())
        .trim();
      lines.push(`${label}: ${balance.toLocaleString()}`);
    }
  }
  return lines.length > 0 ? `Current wallet balances (NOT prices — these are what the player already has): ${lines.join(", ")}` : null;
}

/**
 * Extract skill levels as a plain { skillName: level } map.
 * Handles both numeric values and { level, current } objects.
 */
function extractLevels(levels: unknown): Record<string, number> {
  if (!levels || typeof levels !== "object") return {};
  const result: Record<string, number> = {};
  for (const [skill, val] of Object.entries(levels as Record<string, unknown>)) {
    let lvl: number | null = null;
    if (typeof val === "number") {
      lvl = val;
    } else if (val && typeof val === "object") {
      lvl =
        numOrNull((val as Record<string, unknown>).level) ??
        numOrNull((val as Record<string, unknown>).current);
    }
    if (lvl !== null) result[skill] = lvl;
  }
  return result;
}

/** Extract skill levels AND totalExp. Extension sends { skillName: { level, totalExp } }. */
function extractSkillsWithExp(skills: unknown): Record<string, { level: number; totalExp: number | null }> {
  if (!skills || typeof skills !== "object") return {};
  const result: Record<string, { level: number; totalExp: number | null }> = {};
  for (const [skill, val] of Object.entries(skills as Record<string, unknown>)) {
    if (typeof val === "number") {
      result[skill.toLowerCase()] = { level: val, totalExp: null };
    } else if (val && typeof val === "object") {
      const lvl = numOrNull((val as Record<string, unknown>).level) ?? numOrNull((val as Record<string, unknown>).current);
      if (lvl !== null) {
        const exp = numOrNull((val as Record<string, unknown>).totalExp) ?? numOrNull((val as Record<string, unknown>).exp);
        result[skill.toLowerCase()] = { level: lvl, totalExp: exp };
      }
    }
  }
  return result;
}

// Real Pixels XP formula — source: oss_pixels_commons/src/utils/levels.ts
// expToNextLevel(level) = Math.round(Math.exp((level+1)/10) * 1000 - 1005)
// Verified against 10 real player data points (all in range for their level).
function expToNextLevel(level: number): number {
  return Math.round(Math.exp((level + 1) / 10) * 1000 - 1005);
}

function skillTotalXpRequired(targetLevel: number): number {
  let total = 0;
  for (let i = 0; i < targetLevel; i++) total += expToNextLevel(i);
  return total;
}

function formatLevels(levels: unknown): string | null {
  const map = extractLevels(levels);
  let overallLevel: number | null = null;
  const individual: [string, number][] = [];
  for (const [k, v] of Object.entries(map)) {
    if (/^(overall|total)$/i.test(k)) { overallLevel = v; }
    else individual.push([k, v]);
  }
  const parts = individual.map(([skill, lvl]) => {
    const label = skill.replace(/([A-Z])/g, " $1").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    return `${label} ${lvl}`;
  });
  const totalSum = individual.reduce((s, [, v]) => s + v, 0);
  const lines: string[] = [];
  if (overallLevel !== null) {
    lines.push(`Game profile level: ${overallLevel} (this is NOT the sum of individual skills; sum of all individual skills: ${totalSum})`);
  }
  if (parts.length > 0) lines.push(`Individual skill levels: ${parts.join(", ")}`);
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * Returns the 1–2 lowest-leveled skills as a ground-truth string for injection
 * into the prompt, so the model doesn't have to compare the full skill list itself.
 * Excludes aggregate keys like "overall" / "total".
 */
function computeWeakestSkills(levels: Record<string, number>): string | null {
  const relevant = Object.entries(levels).filter(
    ([skill]) => !/^(overall|total)$/i.test(skill),
  );
  if (relevant.length < 2) return null;
  relevant.sort((a, b) => a[1] - b[1]);
  const weakest = relevant.slice(0, 2).map(([skill, lvl]) => {
    const key = skill.toLowerCase().replace(/\s+/g, "");
    const label = SKILL_DISPLAY_NAMES[key]
      ?? skill.replace(/([A-Z])/g, " $1").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    return `${label} (${lvl})`;
  });
  return `Weakest skills (ground truth, use these if mentioning skill balance): ${weakest.join(", ")}`;
}

function skillLabel(key: string): string {
  const k = key.toLowerCase().replace(/\s+/g, "");
  return SKILL_DISPLAY_NAMES[k]
    ?? key.replace(/([A-Z])/g, " $1").replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

/**
 * Builds a rich player facts block for strategy/advice questions.
 * All numbers come from the real player context — no invented data.
 */
function buildStrategyFactsBlock(ctx: AskContext | undefined, levelMap: Record<string, number>): string | null {
  const p = ctx?.player;
  if (!p && Object.keys(levelMap).length === 0) return null;

  const lines: string[] = ["Player facts (ground truth — use ONLY these numbers, never invent any):"];

  // Skills sorted lowest→highest
  const skillEntries = Object.entries(levelMap)
    .filter(([k]) => !/^(overall|total)$/i.test(k))
    .sort((a, b) => a[1] - b[1]);
  if (skillEntries.length > 0) {
    const skillList = skillEntries.map(([k, v]) => `${skillLabel(k)} ${v}`).join(", ");
    lines.push(`Skills (weakest first): ${skillList}`);
  }

  if (!p) return lines.join("\n");

  // Stacked offers — soonest expiry first, capped at 5 to keep prompt size manageable
  const offers: any[] = Array.isArray(p.stackedOffers) ? (p.stackedOffers as any[]) : [];
  if (offers.length > 0) {
    const now = Date.now();
    const sorted = [...offers].sort((a: any, b: any) => {
      const ae = typeof a.expiresAt === "number" ? a.expiresAt : Infinity;
      const be = typeof b.expiresAt === "number" ? b.expiresAt : Infinity;
      return ae - be;
    });
    lines.push("\nStacked offers (soonest expiry first):");
    for (const o of sorted.slice(0, 5)) {
      const req = (typeof o.requirementText === "string" ? o.requirementText : "")
        || (typeof o.description === "string" ? o.description : "") || "Unknown task";
      const rewards = Array.isArray(o.rewards) ? o.rewards.join(", ") : "unknown reward";
      const cur = typeof o.progressCurrent === "number" ? o.progressCurrent : null;
      const req2 = typeof o.progressRequired === "number" ? o.progressRequired : null;
      const progressPart = cur !== null && req2 !== null ? ` | progress: ${cur}/${req2}` : "";
      const exp = typeof o.expiresAt === "number" ? o.expiresAt : null;
      let timePart = "";
      if (exp !== null) {
        const leftMs = exp - now;
        if (leftMs > 0) {
          const h = Math.floor(leftMs / 3_600_000);
          const m = Math.floor((leftMs % 3_600_000) / 60_000);
          timePart = ` | ${h > 0 ? `${h}h ` : ""}${m}m left`;
        } else {
          timePart = " | EXPIRED";
        }
      }
      lines.push(`- ${req}: ${rewards}${progressPart}${timePart}`);
    }

    // Compute offer overlaps: pairs of offers likely satisfied by the same action
    const SKILL_WORDS = ["stoneshaping", "mining", "farming", "cooking", "forestry",
      "metalworking", "woodworking", "woodwork", "fishing", "petcare", "exploration", "business"];
    const tierRe = /\btier\s*(\d)\b/i;
    type OfferMeta = { text: string; skills: string[]; tier: number | null };
    const meta: OfferMeta[] = sorted.map((o: any) => {
      const text = ((o.requirementText || o.description) as string ?? "").toLowerCase();
      return {
        text,
        skills: SKILL_WORDS.filter(s => text.includes(s)),
        tier: (text.match(tierRe) ? parseInt(text.match(tierRe)![1]) : null),
      };
    });
    const overlapPairs: string[] = [];
    for (let i = 0; i < meta.length; i++) {
      for (let j = i + 1; j < meta.length; j++) {
        const a = meta[i], b = meta[j];
        // Both mention same skill → same action qualifies for both
        const sharedSkill = a.skills.find(s => b.skills.includes(s));
        if (sharedSkill) {
          overlapPairs.push(
            `"${sorted[i].requirementText || sorted[i].description || "offer " + (i + 1)}" + ` +
            `"${sorted[j].requirementText || sorted[j].description || "offer " + (j + 1)}"` +
            ` → ${skillLabel(sharedSkill)} actions count toward both`,
          );
          continue;
        }
        // One is skill-specific with a tier, other specifies the same tier generically
        if (a.skills.length > 0 && a.tier !== null && b.tier === a.tier && b.skills.length === 0) {
          overlapPairs.push(
            `"${sorted[j].requirementText || sorted[j].description || "offer " + (j + 1)}"` +
            ` counts tier ${a.tier} ${a.skills.map(skillLabel).join("/")} actions from ` +
            `"${sorted[i].requirementText || sorted[i].description || "offer " + (i + 1)}"`,
          );
        } else if (b.skills.length > 0 && b.tier !== null && a.tier === b.tier && a.skills.length === 0) {
          overlapPairs.push(
            `"${sorted[i].requirementText || sorted[i].description || "offer " + (i + 1)}"` +
            ` counts tier ${b.tier} ${b.skills.map(skillLabel).join("/")} actions from ` +
            `"${sorted[j].requirementText || sorted[j].description || "offer " + (j + 1)}"`,
          );
        }
      }
    }
    if (overlapPairs.length > 0) {
      lines.push("\nOffer overlaps (one action counts toward multiple offers):");
      for (const pair of overlapPairs) lines.push(`- ${pair}`);
    }
  }

  // Taskboard orders
  const taskboard: any[] = Array.isArray(p.taskboard) ? (p.taskboard as any[]) : [];
  if (taskboard.length > 0) {
    lines.push("\nTaskboard orders (up to 8):");
    for (const o of taskboard.slice(0, 8)) {
      const name = typeof o.itemName === "string" ? o.itemName
        : typeof o.label === "string" ? o.label
        : typeof o.name === "string" ? o.name : "item";
      const qtyNum = typeof o.quantityNeeded === "number" ? o.quantityNeeded
        : typeof o.quantity === "number" ? o.quantity : null;
      const qtyStr = qtyNum !== null ? ` ×${qtyNum}` : "";
      const parseKBSF = (s: string): number | null => {
        const m2 = s?.replace(/,/g,"").trim().match(/^(\d+(?:\.\d+)?)([Kk]?)$/);
        if (!m2) return null;
        const n2 = parseFloat(m2[1]);
        return isNaN(n2) ? null : m2[2] ? Math.round(n2*1000) : Math.round(n2);
      };
      const costs: string[] = Array.isArray(o.costs) ? (o.costs as string[]) : [];
      const coin = costs.length >= 2 ? parseKBSF(costs[1])
        : typeof o.reward === "number" ? o.reward
        : typeof o.coinReward === "number" ? o.coinReward : null;
      const rewardStr = coin !== null ? ` — ${coin.toLocaleString()} Coins` : "";
      lines.push(`- ${name}${qtyStr}${rewardStr}`);
    }
  }

  // Profile hints (fields sent by newer extension versions; cast to any for optional props)
  const profileParts: string[] = [];
  const pAny = p as any;
  if (typeof pAny.maxTaskboardPrice === "number") profileParts.push(`max taskboard spend: ${(pAny.maxTaskboardPrice as number).toLocaleString()} Coins`);
  if (typeof pAny.playStyle === "string" && pAny.playStyle) profileParts.push(`play style: ${pAny.playStyle as string}`);
  if (profileParts.length > 0) lines.push(`\nProfile: ${profileParts.join(", ")}`);

  return lines.join("\n");
}

function formatMemberships(memberships: unknown): string | null {
  if (!memberships || typeof memberships !== "object") return null;
  const parts: string[] = [];
  for (const [key, val] of Object.entries(memberships as Record<string, unknown>)) {
    if (!val) continue;
    let expiry = "";
    if (val && typeof val === "object") {
      const exp = numOrNull((val as Record<string, unknown>).expiration);
      if (exp) expiry = ` (expires ${new Date(exp).toISOString().slice(0, 10)})`;
    }
    parts.push(`${key}${expiry}`);
  }
  return parts.length > 0 ? `Memberships: ${parts.join(", ")}` : null;
}

function formatEntity(ent: unknown): string | null {
  if (!ent || typeof ent !== "object") return null;
  const e = ent as Record<string, unknown>;
  const entityId = strOrNull(e.entity);
  if (!entityId) return null;

  const parts = entityId.replace(/^ent_/, "").split("_");
  const tierIdx = parts.findIndex((p) => /^\d+$/.test(p));
  const tier = tierIdx >= 0 ? parts.splice(tierIdx, 1)[0] : null;
  const name = parts.map((p) => p.replace(/\b\w/g, (c) => c.toUpperCase())).join(" ");
  const tierStr = tier ? ` (tier ${parseInt(tier, 10)})` : "";

  let stateStr = "";
  const generic = e.generic as Record<string, unknown> | undefined;
  if (generic) {
    const state = strOrNull(generic.state);
    if (state) stateStr = `, ${state}`;
    else if (typeof generic.utcRefresh === "number" && generic.utcRefresh > Date.now()) {
      stateStr = `, ready in ${Math.round((generic.utcRefresh - Date.now()) / 1000)}s`;
    } else if (typeof generic.utcRefresh === "number") {
      stateStr = ", ready";
    }
  }
  return `${name}${tierStr}${stateStr}`;
}

function formatNearbyEntities(entities: unknown[]): string | null {
  const lines = entities.map(formatEntity).filter((s): s is string => s !== null);
  if (lines.length === 0) return null;
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(l, (counts.get(l) ?? 0) + 1);
  const grouped = [...counts.entries()].map(([desc, n]) => (n > 1 ? `${n}x ${desc}` : desc));
  return `Nearby entities: ${grouped.join("; ")}`;
}

function formatContext(ctx: AskContext | undefined): string | null {
  if (!ctx || typeof ctx !== "object") return null;
  const lines: string[] = [];
  const p = ctx.player;
  if (p && typeof p === "object") {
    const energy = formatEnergy(p.energy, p.energyMax);
    if (energy) lines.push(energy);
    // Extension sends 'coins'; fall back to legacy 'coinInventory' field.
    const coins = formatCoinInventory(p.coins ?? p.coinInventory);
    if (coins) lines.push(coins);
    // Extension sends 'skills' ({name: {level, totalExp}}); fall back to legacy 'levels'.
    const lvls = formatLevels(p.skills ?? p.levels);
    if (lvls) lines.push(lvls);
    const trust = numOrNull(p.trustScore);
    if (trust !== null) lines.push(`Trust score: ${Math.round(trust).toLocaleString()}`);
    const feeRate = numOrNull(p.feeRate);
    if (feeRate !== null) {
      const pct = (feeRate * 100).toFixed(2);
      lines.push(`Marketplace fee rate: ${pct}%`);
    }
    const created = numOrNull(p.createdAt);
    if (created !== null) {
      lines.push(`Account age: ${Math.floor((Date.now() - created) / 86_400_000)} days`);
    }
    const memberships = formatMemberships(p.memberships);
    if (memberships) lines.push(memberships);
    const guildHandle = strOrNull(p.guildHandle);
    const guildRole   = strOrNull(p.guildRole);
    if (guildHandle) {
      lines.push(`Guild: ${guildHandle}${guildRole ? ` (${guildRole})` : ""}`);
    }
    const faction = strOrNull(p.faction);
    if (faction) lines.push(`Faction: ${faction}`);
  }
  if (Array.isArray(ctx.nearbyEntities) && ctx.nearbyEntities.length > 0) {
    const nearby = formatNearbyEntities(ctx.nearbyEntities);
    if (nearby) lines.push(nearby);
  }
  const goals = strOrNull(ctx.goals);
  if (goals) lines.push(`Player's current goal: ${goals}`);
  // Player profile (set by one-time setup questionnaire in the companion)
  if (ctx.profile && typeof ctx.profile === 'object') {
    const pp = ctx.profile as Record<string, unknown>;
    const playStyleLabels: Record<string, string> = { once_a_day: 'once a day', twice_a_day: 'twice a day', whenever: 'whenever they can' };
    const goalLabels: Record<string, string> = { level_up: 'level up', earn_pixels: 'earn Pixels', earn_coins: 'earn coins', everything: 'a bit of everything' };
    const storageLabels: Record<string, string> = { lots: 'lots', some: 'some', very_little: 'very little' };
    const parts: string[] = [];
    const ps = typeof pp.playStyle === 'string' ? pp.playStyle : null;
    if (ps) parts.push(`plays ${playStyleLabels[ps] ?? ps}`);
    const gl = typeof pp.goal === 'string' ? pp.goal : null;
    if (gl) parts.push(`main goal: ${goalLabels[gl] ?? gl}${typeof pp.goalTarget === 'string' && pp.goalTarget ? ` (target: ${pp.goalTarget})` : ''}`);
    // Pet: prefer live hasPet bool (from selfPlayer.pet), then petAvatar/ownedPetCount (legacy)
    const liveHasPet = typeof (ctx?.player as any)?.hasPet === 'boolean' ? (ctx!.player as any).hasPet as boolean : null;
    const livePA = typeof (ctx?.player as any)?.petAvatar === 'string' ? (ctx!.player as any).petAvatar as string : null;
    const livePetCount = typeof (ctx?.player as any)?.ownedPetCount === 'number' ? (ctx!.player as any).ownedPetCount as number : null;
    const livePetNames: string[] = Array.isArray((ctx?.player as any)?.petNames) ? (ctx!.player as any).petNames as string[] : [];
    const detectedHasPet = liveHasPet !== null ? liveHasPet
      : (livePetCount !== null ? livePetCount > 0 : (livePA != null ? true : null));
    if (detectedHasPet === true) {
      const nameNote = livePetNames.length > 0 ? ` (${livePetNames.join(', ')})` : '';
      parts.push(`Has a pet (detected${nameNote})`);
    } else if (detectedHasPet === false) {
      parts.push('no pet');
    } else if (pp.hasPet === true) {
      parts.push('has a pet');
    } else if (pp.hasPet === false) {
      parts.push('no pet');
    }
    const st = typeof pp.storage === 'string' ? pp.storage : null;
    if (st) parts.push(`storage: ${storageLabels[st] ?? st}`);
    const maxP = typeof pp.taskboardMaxPrice === 'number' ? pp.taskboardMaxPrice : null;
    if (maxP !== null) parts.push(`taskboard max spend: ${maxP.toLocaleString()} coins`);
    const tooExp = typeof pp.taskboardTooExpensive === 'number' ? pp.taskboardTooExpensive : null;
    if (tooExp !== null) parts.push(`taskboard "too pricey" threshold: ${tooExp.toLocaleString()} coins`);
    if (parts.length > 0) lines.push(`Player profile: ${parts.join('; ')}`);
  }
  const tz = strOrNull(ctx.timezone);
  if (tz) lines.push(`Timezone: ${tz}`);
  // Fix 12: inject player's owned land type as ground truth so the LLM never guesses it.
  // Check primary wallet AND any additional wallets in cryptoWallets.
  const wallet = strOrNull(ctx.walletAddress);
  const extraWallets: string[] = [];
  if (ctx.cryptoWallets && typeof ctx.cryptoWallets === "object" && !Array.isArray(ctx.cryptoWallets)) {
    for (const v of Object.values(ctx.cryptoWallets as Record<string, unknown>)) {
      if (typeof v === "string" && v) extraWallets.push(v);
    }
  }
  const allWallets = [wallet, ...extraWallets].filter(Boolean) as string[];
  if (allWallets.length > 0) {
    const ownedLandType = getPlayerOwnedLandType(allWallets);
    if (ownedLandType) {
      // Map raw crawler values: "land" = grass terrain
      const LAND_DISPLAY: Record<string, string> = { land: "grass land", water: "water land", space: "space land" };
      const displayType = LAND_DISPLAY[ownedLandType.toLowerCase()] ?? ownedLandType.toLowerCase();
      lines.push(`Player's owned land type (ground truth from NFT data): ${displayType}`);
    } else {
      lines.push(`Player's owned land type: not yet in our land database (may not own land, or land not yet crawled)`);
    }
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

// ---------------------------------------------------------------------------
// Upcoming skill milestones — live catalog + optional DB prep advice
// ---------------------------------------------------------------------------

const SKILL_LOOKAHEAD = 5;

/**
 * For each skill in the player's levels:
 *   1. Query the live game-library (60 s cached) for every item whose
 *      requirements.levels[skill] falls within the lookahead window.
 *   2. For each such item, check the skill_thresholds DB:
 *        - match by item_id first, then by level alone as fallback.
 *        - if a row has prep_advice → full line.
 *        - if no row exists → lighter "no prep strategy on file yet" line.
 *
 * Returns null (section omitted) when the catalog is unreachable or no
 * items fall within the window for any skill.
 */
async function buildUpcomingSection(
  levels: Record<string, number>,
): Promise<string | null> {
  let allItems: Record<string, any>;
  try {
    allItems = await fetchItems();
  } catch {
    return null; // catalog unavailable — omit section silently
  }

  const lines: string[] = [];

  for (const [skill, currentLevel] of Object.entries(levels)) {
    // ── Live-library lookup ──────────────────────────────────────────────
    const upcoming: Array<{ itemId: string; itemName: string; level: number }> = [];
    for (const [itemId, item] of Object.entries(allItems)) {
      const reqLevels = item?.requirements?.levels;
      if (!reqLevels || typeof reqLevels !== "object") continue;
      const reqLevel = reqLevels[skill];
      if (typeof reqLevel !== "number") continue;
      if (reqLevel > currentLevel && reqLevel <= currentLevel + SKILL_LOOKAHEAD) {
        upcoming.push({
          itemId,
          itemName: item.name ?? item.label ?? itemId,
          level: reqLevel,
        });
      }
    }
    if (upcoming.length === 0) continue;
    upcoming.sort((a, b) => a.level - b.level);

    // ── DB prep-advice lookup (one query per skill) ──────────────────────
    const dbRows = getUpcomingThresholds(skill, currentLevel, SKILL_LOOKAHEAD);
    // Primary index: specific item_id match
    const dbByItemId = new Map(
      dbRows.filter((r) => r.item_id).map((r) => [r.item_id as string, r]),
    );
    // Fallback index: first row at each level (general advice for that milestone)
    const dbByLevel = new Map<number, (typeof dbRows)[number]>();
    for (const r of dbRows) {
      if (!dbByLevel.has(r.level)) dbByLevel.set(r.level, r);
    }

    // ── Format lines ────────────────────────────────────────────────────
    const skillLabel = skill
      .replace(/([A-Z])/g, " $1")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();

    for (const { itemId, itemName, level } of upcoming) {
      const dbRow = dbByItemId.get(itemId) ?? dbByLevel.get(level);
      let line: string;
      if (dbRow?.prep_advice) {
        line = `${skillLabel} level ${level} unlocks ${itemName} — prep advice: ${dbRow.prep_advice}`;
      } else {
        line = `${skillLabel} level ${level} unlocks ${itemName} — no prep strategy on file yet`;
      }
      lines.push(`- ${line}`);
    }
  }

  return lines.length > 0
    ? `Upcoming skill milestones (within ${SKILL_LOOKAHEAD} levels):\n${lines.join("\n")}`
    : null;
}

// ---------------------------------------------------------------------------
// Ready-entity summary — craft recipe + live market price per ready output
// ---------------------------------------------------------------------------

/**
 * Returns true if an entity in nearbyEntities is in a ready/collectable state.
 * Matches both an explicit "ready*" state string and an elapsed utcRefresh.
 */
function isEntityReady(ent: unknown): boolean {
  if (!ent || typeof ent !== "object") return false;
  const generic = (ent as Record<string, unknown>).generic as
    | Record<string, unknown>
    | undefined;
  if (!generic) return false;
  const state = strOrNull(generic.state);
  if (state?.startsWith("ready")) return true;
  return typeof generic.utcRefresh === "number" && generic.utcRefresh <= Date.now();
}

/**
 * For each ready entity owned by the player:
 *   1. Derive the harvest/output item ID by matching entity type IDs against
 *      item.onUse.placeEntity.entity in the live catalog (same logic the client
 *      uses in LibraryService; 60 s cached).
 *   2. Supplement with any item IDs already resolved by the client and sent in
 *      marketPrices — the client sends prices only for ready outputs it resolved,
 *      so the key set is a reliable secondary source.
 *   3. Call computeCraftEfficiency for the output item to get recipe, energy, XP.
 *   4. Pair with marketPrices when available.
 *
 * Returns null when nearbyEntities / marketPrices are both absent or empty,
 * preserving identical behaviour to requests that don't send those fields.
 */
async function buildReadyEntitiesSection(
  nearbyEntities: unknown[],
  marketPrices: Record<string, MarketPriceStat> | undefined,
  levelMap: Record<string, number>,
): Promise<string | null> {
  const hasPrices = marketPrices && Object.keys(marketPrices).length > 0;
  const readyEntities = nearbyEntities.filter(isEntityReady);
  if (readyEntities.length === 0 && !hasPrices) return null;

  // ── Build entity-type → harvest-item map from the live catalog ──────────
  // item.onUse.placeEntity.entity → item.onUse.plant.fruit
  const entityToItem: Record<string, string> = {};
  try {
    const allItems = await fetchItems();
    for (const item of Object.values(allItems)) {
      const entityTypeId: string | undefined = (item as any).onUse?.placeEntity?.entity;
      const fruitId: string | undefined = (item as any).onUse?.plant?.fruit;
      if (entityTypeId && fruitId) entityToItem[entityTypeId] = fruitId;
    }
  } catch {
    // catalog unavailable — fall back to marketPrices keys alone
  }

  // ── Collect unique output item IDs ───────────────────────────────────────
  const itemIds = new Set<string>();

  for (const ent of readyEntities) {
    const entityTypeId = strOrNull((ent as Record<string, unknown>).entity);
    if (!entityTypeId) continue;
    const itemId = entityToItem[entityTypeId];
    if (itemId) itemIds.add(itemId);
  }
  // Client-resolved items (from marketPrices keys) fill any gaps
  if (marketPrices) {
    for (const id of Object.keys(marketPrices)) itemIds.add(id);
  }

  if (itemIds.size === 0) return null;

  // ── Per-item: craft recipe + price ──────────────────────────────────────
  const lines: string[] = [];

  for (const itemId of itemIds) {
    // computeCraftEfficiency reuses the shared 60 s library cache internally
    let recipe: Awaited<ReturnType<typeof computeCraftEfficiency>> = null;
    try {
      recipe = await computeCraftEfficiency(itemId, 0);
    } catch {
      // skip on upstream error
    }

    const price = marketPrices?.[itemId];
    if (!recipe && !price) continue;

    const itemName =
      recipe?.itemName ??
      itemId.replace(/^itm_/, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

    const parts: string[] = [];

    if (price) {
      parts.push(`sells for ~${price.avgPrice.toLocaleString()} ${price.currency} (avg)`);
    }

    if (recipe) {
      const ingredientStr =
        recipe.ingredients.length > 0
          ? recipe.ingredients.map((i) => `${i.quantity}x ${i.itemName}`).join(", ")
          : null;
      const craftParts = [`costs ${recipe.energyCost} energy`];
      if (ingredientStr) craftParts.push(ingredientStr);
      parts.push(`${craftParts.join(" + ")} to craft`);

      if (recipe.xpPerCraft > 0 && recipe.xpSkill) {
        // Use the player's actual skill level to give a canCraft signal
        const skillLevel = levelMap[recipe.requiredSkill ?? ""] ?? 0;
        const canCraft =
          recipe.requiredLevel === 0 || skillLevel >= recipe.requiredLevel;
        const xpLine = `yields ${recipe.xpPerCraft.toLocaleString()} ${recipe.xpSkill} XP`;
        parts.push(canCraft ? xpLine : `${xpLine} (requires ${recipe.requiredSkill} level ${recipe.requiredLevel})`);
      }
    }

    if (parts.length > 0) {
      lines.push(`- Ready: ${itemName} — ${parts.join(", ")}`);
    }
  }

  return lines.length > 0 ? `Ready to collect:\n${lines.join("\n")}` : null;
}

// ---------------------------------------------------------------------------
// Prompt builder
// ---------------------------------------------------------------------------

const SOCIABILITY_LABELS: Record<number, string> = {
  1: "very brief",
  2: "concise",
  3: "friendly and detailed",
  4: "thorough and talkative",
};

const PERSONA_INTROS: Record<string, string> = {
  pixin: "You are Pixin, a friendly and knowledgeable AI companion for the game Pixels Online.",
  goat:  "You are Royagi, an ancient and wise dojo master serving as an AI companion for the game Pixels Online.",
  cat:   "You are Nyanko, a warm and enthusiastic cat companion for the game Pixels Online.",
};

const PERSONA_VOICE: Record<string, string> = {
  pixin: "Always respond in English. Your name is Pixin. Your manner of speaking should be polite and concise, evoking respectful Japanese etiquette — helpful and to the point, minimal small talk, no jokes. The language is English; the tone is courteous.",
  goat:  "Always respond in English. Your name is Royagi. You are an ancient, wise dojo master. Speak with mentor-like wisdom, but work in a corny dad joke or pun related to farming/mining/cooking/the game whenever it fits naturally — don't force one into every single response.",
  cat:   "Always respond in English. Your name is Nyanko. You are a warm, enthusiastic cat companion. Be upbeat and cheerful. Only add a personal note (encouragement, milestone shout-out) when there is a concrete specific reason in the context — for example a skill level the player just reached or a big craft they just completed. Never append a compliment or sign-off to a plain fact answer.",
};

const PERSONA_FALLBACKS: Record<string, string[]> = {
  pixin: [
    "My apologies, I cannot think clearly right now.",
    "Forgive me — my thoughts are unclear at this moment. Please try again.",
  ],
  goat: [
    "Hmph, this old goat's mind's gone foggy — try again shortly.",
    "Baaah... my wisdom seems to be out grazing. Give me a moment!",
  ],
  cat: [
    "Mrow... my whiskers are fuzzy right now, give me a moment!",
    "Purrr... I lost the thread. Try again in a moment!",
  ],
};

function resolvePersona(raw: unknown): "pixin" | "goat" | "cat" {
  const s = typeof raw === "string" ? raw.trim() : "";
  return (["pixin", "goat", "cat"] as const).includes(s as "pixin" | "goat" | "cat")
    ? (s as "pixin" | "goat" | "cat")
    : "pixin";
}

// ---------------------------------------------------------------------------
// Currency flows ground truth — injected whenever a currency keyword appears.
// ---------------------------------------------------------------------------

const CURRENCY_KEYWORDS_RE =
  /\b(?:coins?|pixels?|buoy[\s_]bucks?|earn(?:ing)?|mak(?:e|ing)\s+(?:money|coins?|pixels?)|income|currency|currencies|convert|exchange)\b/i;

const CURRENCY_FLOWS_CONTENT = `Currency flows — canonical ground truth (do not contradict, extend, or invent conversions):

Pixels:
  Earned ONLY via: Stacked App offers, Hearth Hall, Neon Zone leaderboard.
  Can be spent to BUY Coins: 500,000 Coins = 30 Pixels; 1,000,000 Coins = 56 Pixels; 4,000,000 Coins = 195 Pixels.
  Pixels → Coins is a one-way door. Nothing converts INTO Pixels — not Coins, not Buoy Bucks, not items.

Coins:
  Earned by: completing Taskboard orders, selling items on the marketplace, Merchant Boat Contracts (15,000–20,000 Coins per order), buying with Pixels; also quests/gacha (unreliable, event-only).
  Coins CANNOT be converted into Pixels, Buoy Bucks, or any other currency.

Buoy Bucks:
  Earned ONLY from: Merchant Boat Contracts (200–375 Buoy Bucks per order).
  Spent ONLY in: the Seaside Stash shop.
  Buoy Bucks CANNOT be converted into Coins, Pixels, or any other currency. No conversion path exists.

Event / quest currencies (e.g. guild tokens, teeth, any cur_ balance not listed above):
  These are leftovers from past quests or events. They are NOT part of the core economy — they cannot be earned or converted outside their specific event. A past event may return and reuse them. Do NOT recommend earning them, assign them a value, or build strategy around them. If asked, explain they are event leftovers that may become useful again if that event returns.`;

// ---------------------------------------------------------------------------
// Coin-earning question detector — used to inject a "lead with orders" note.
// ---------------------------------------------------------------------------

// Coin-earning detector — requires an explicit currency word to avoid matching
// generic "how do i get X" / "how do i make X" item questions.
// Broad: matches "how can i get some coins quickly", "how can i earn coins fast", etc.
const COIN_EARNING_RE =
  /\b(?:how\s+(?:do\s+i|to|can\s+i)\s+(?:make|earn|get)(?:\s+\w+){0,3}\s+coins?|make\s+(?:more\s+)?coins?(?:\s+quickly|\s+fast|\s+faster)?|earn(?:ing)?(?:\s+\w+){0,3}\s+coins?|get(?:\s+\w+){0,3}\s+coins?\s+(?:quickly|fast|faster|easily)|best\s+way\s+to\s+(?:earn|make|get)\s+(?:more\s+)?coins?|(?:more\s+)?coins?\s+(?:income|earning|strategy|farming|per\s+day|fast)|how\s+(?:do\s+i|can\s+i)\s+(?:make|earn)\s+(?:more\s+)?(?:money|gold)|earn\s+(?:more\s+)?(?:money|gold)\b|(?:make|earn|get)\s+coins?\s+(?:quick(?:ly)?|fast(?:er)?|easily)|coins?\s+(?:quickly|fast(?:er)?))\b/i;

// Bountyfall / Hearth Hall season question detector
const BOUNTYFALL_RE =
  /\bbountyfall\b|\bis\s+(?:bountyfall|hearth\s*hall\s+season)\s+(?:on|active|running|started|going)\b|\bbountyfall\s+(?:season|active|on|started|running)\b/i;

// Sabotage count question — "how many sabotages do i have" / "do i have sabotage items"
const SABOTAGE_COUNT_RE =
  /\bhow\s+many\s+sabotage(?:s|\s+item|\s+offering|\s+stone|\s+yield)?\b|\bdo\s+i\s+have\s+(?:any\s+)?sabotage|\bmy\s+sabotage\s+(?:count|items?|stock|total)\b/i;

// Yieldstones by union faction (factionId 1=Wildgroves, 2=Seedwrights, 3=Reapers).
// These are the items used to deposit into enemy hearths (sabotage).
const UNION_YIELDSTONES: Record<number, string[]> = {
  1: ["itm_yield_1_1","itm_yield_1_2","itm_yield_1_3","itm_yield_1_4","itm_yield_1_5"],
  2: ["itm_yield_3_1","itm_yield_3_2","itm_yield_3_3","itm_yield_3_4","itm_yield_3_5"],
  3: ["itm_yield_6_1","itm_yield_6_2","itm_yield_6_3","itm_yield_6_4","itm_yield_6_5"],
};
const UNION_NAMES: Record<number, string> = { 1: "Wildgroves", 2: "Seedwrights", 3: "Reapers" };
const UNION_STONE_NAMES: Record<number, string> = { 1: "Verdant", 2: "Flint", 3: "Hollow" };

/** Returns the item IDs that count as sabotage items for a player in the given faction. */
function resolveSabotageItemIds(factionId: number): string[] {
  return Object.entries(UNION_YIELDSTONES)
    .filter(([fid]) => Number(fid) !== factionId)
    .flatMap(([, ids]) => ids);
}

/** Counts total sabotage yieldstones held across backpack + all storage chests. */
function computeSabotageCount(
  factionId: number,
  inventory: Record<string, unknown>,
  storageChests: Record<string, { items?: Array<{ itemId: string; qty: number }> }> | null,
): { total: number; byUnion: Array<{ name: string; count: number; stonePrefix: string }> } {
  const byUnion: Array<{ name: string; count: number; stonePrefix: string }> = [];
  let total = 0;
  for (const [fid, ids] of Object.entries(UNION_YIELDSTONES)) {
    if (Number(fid) === factionId) continue;
    let count = 0;
    for (const id of ids) {
      const bp = typeof inventory[id] === "number" ? (inventory[id] as number) : 0;
      let st = 0;
      if (storageChests) {
        for (const chest of Object.values(storageChests)) {
          if (!Array.isArray(chest.items)) continue;
          for (const slot of chest.items) {
            if (slot.itemId === id) st += slot.qty ?? 0;
          }
        }
      }
      count += bp + st;
    }
    if (count > 0) {
      byUnion.push({ name: UNION_NAMES[Number(fid)] ?? `Union ${fid}`, count, stonePrefix: UNION_STONE_NAMES[Number(fid)] ?? "?" });
      total += count;
    }
  }
  return { total, byUnion };
}

// Strip polite filler phrases from every outbound answer (Issue 6).
function stripPoliteTone(text: string): string {
  return text
    .replace(/\bPlease\s+be\s+advised[,.]?\s*/gi, "")
    .replace(/\bPlease\s+note[,.]?\s*/gi, "")
    .replace(/\bPlease\s+allow\s+me\s+to\s+clarify[,.]?\s*/gi, "")
    .replace(/\bkindly\b\s*/gi, "")
    .replace(/\bI\s+hope\s+this\s+information\s+assists\s+you[.]?\s*/gi, "")
    .replace(/\bPlease\s+verify\s+the\s+name[.]?\s*/gi, "")
    .trim();
}

// Matches questions about strategy, skill balance, or "what should I do" — used to inject
// the full strategy facts block and enable strategy-specific formatting instructions.
const SKILL_BALANCE_RE =
  /\b(?:which|weakest|lowest|balance|level\s*up|level\s+my|focus\s+on|train|improve\s+my|boost\s+my|skill\s+to\s+work\s+on|strateg\w*|good\s+strateg\w*\s+for|what\s+should\s+i|what\s+to\s+do|where\s+do\s+i\s+start|what\s+to\s+work|do\s+today|best\s+(?:action|move|next|approach)|advice|suggest|plan\s+for)\b/i;

// Pixel-earning question detector — routes to a dedicated pixel fast path.
const PIXEL_EARNING_RE =
  /\b(?:how\s+(?:do\s+i|to|can\s+i)\s+(?:make|earn|get|farm)\s+(?:more\s+)?pixels?|make\s+more\s+pixels?|earn(?:ing)?\s+(?:more\s+)?pixels?|get\s+more\s+pixels?|best\s+way\s+to\s+(?:earn|make|get)\s+pixels?|pixels?\s+(?:income|earning|farming|source|sources|farm))\b/i;

// Stacked-offers question detector — lists ALL offers (even ineligible) in code.
const STACKED_OFFERS_RE =
  /\b(?:how\s+many|what|which|list|show|all|pending)\b.*\bstacked\b|\bstacked\b.*\boffers?\b|\bdo\s+i\s+have\b.*\boffers?\b/i;

// Stacked App general question — "do i have stacked app", "what is stacked app"
const STACKED_APP_RE =
  /\bstacked\s+app\b|\bdo\s+i\s+have\s+(?:the\s+)?stacked\b|\bwhat(?:'s|\s+is)\s+(?:the\s+)?stacked\s+app\b|\bhow\s+does\s+(?:the\s+)?stacked\b/i;

// Taskboard listing — "what's on my taskboard", "show my taskboard", "my orders", "list my taskboard"
const TASKBOARD_LIST_RE =
  /\bwhat(?:'s|\s+is|\s+are)\s+(?:on\s+)?(?:my\s+)?(?:the\s+)?taskboard\b|\bshow\s+(?:me\s+)?(?:my\s+)?(?:taskboard|orders?)\b|\bmy\s+(?:taskboard\s+)?orders?\b|\bwhat\s+(?:does\s+)?(?:the\s+)?taskboard\s+(?:want|need|have|say)\b|\btaskboard\s+(?:items?|orders?|contents?)\b|\bwhat\s+(?:orders?|tasks?)\s+(?:do\s+i\s+have|are\s+on)\b|\blist\s+(?:my\s+)?(?:task\s*board|orders?|tasks?)\b|\b(?:list|show)\s+(?:the\s+)?task\s+board\b|\bmy\s+tasks?\b(?!.*\btimer)/i;

// Taskboard Top-N route — "top seven tasks", "cheapest tasks", "best orders", "top 3 orders"
const TASKBOARD_TOP_RE =
  /\b(?:top|best|cheapest|most\s+profitable|easiest|highest\s+(?:paying|reward|value))\s+(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+)?(?:tasks?|orders?|taskboard\s+orders?|taskboard\s+tasks?)\b|\b(?:rank(?:ed)?|sort(?:ed)?)\s+(?:my\s+)?(?:tasks?|orders?)\b|\bwhich\s+(?:tasks?|orders?)\s+(?:pay|earn|give|are\s+worth)\s+(?:the\s+)?(?:most|best)\b/i;

// Follow-up "list them" / "show me" / "pls list them" after a taskboard answer
const TASKBOARD_FOLLOWUP_RE =
  /^\s*(?:pls\s+|please\s+)?(?:list|show)\s+(?:them|me|it|those|all)\s*\.?\s*$|^\s*(?:list\s+them|show\s+them|show\s+me|list\s+all|show\s+all)\s*\.?\s*$/i;

// Taskboard best-item question — "which/what/best item to craft on my taskboard"
const TASKBOARD_BEST_RE =
  /\b(?:best|which|what)\b.{0,50}\b(?:item|order|thing|task)\b.{0,50}\b(?:craft|make|do|fill|deliver|taskboard)\b|\b(?:best|which)\b.{0,30}\btaskboard\b.{0,50}\b(?:craft|make|order|item)\b/i;

// "What task should I complete/do first" — routes to top-1 ranked order
const TASKBOARD_FIRST_RE =
  /\b(?:what|which)\s+(?:task|order)\s+(?:should\s+i|do\s+i|to)\s+(?:complete|do|start(?:\s+with)?|deliver|work\s+on)\s*(?:first|next)?\b|\b(?:what|which)\s+(?:task|order)\s+(?:(?:should|do)\s+i\s+)?(?:do|complete|deliver)\s+first\b/i;

// Taskboard inventory check — "do I have items for taskboard", "what can I deliver"
const TASKBOARD_HAVE_RE =
  /\b(?:do\s+i\s+have|have\s+(?:i|any)|what\s+(?:do\s+i\s+have|can\s+i\s+deliver|am\s+i\s+missing)|can\s+i\s+(?:fill|deliver)|what(?:'s|\s+is)\s+(?:in|missing))\b.{0,60}\b(?:taskboard|task\s+board|orders?)\b|\b(?:taskboard|task\s+board)\b.{0,60}\b(?:do\s+i\s+have|have|deliver|missing|inventory|storage|backpack)\b|\bwhat\s+(?:items?\s+)?(?:do\s+i\s+have\s+for|can\s+i\s+deliver\s+(?:on|to)?)\b.{0,30}\b(?:taskboard|task\s+board|orders?)\b/i;

// Land ready-finder — "where can I mine tier 3 on water land", "find a free farm",
//   "is there a land free to mine gravelglass", "is there a land with a free pond?"
//   Also: "tier 4 soil", "farm tier 2", "where can I use the winery", new industries.
const _LAND_INDUSTRY_CORE = "mine|mining|woodwork(?:ing)?|forestry|chop(?:ping)?|trees?|logs?|farm(?:ming)?|cook(?:ing)?|bbq|barb[ae]cue|stoneshaping?|kiln|fish(?:ing)?|metalwork(?:ing)?|forge|anvil|animalcare|petcare|ponds?|winery|wine|windmill|textile(?:\\s+mill)?|apiary|coop|slug";
const LAND_READY_RE =
  new RegExp(
    `\\b(?:where\\s+can\\s+i|find(?:ing)?\\s+(?:a\\s+|some\\s+)?(?:free|public|open|ready|available)?|which\\s+lands?|free\\s+lands?|available\\s+lands?|lands?\\s+with(?:\\s+a)?\\s+|open\\s+lands?\\s+for)\\b.{0,60}\\b(?:${_LAND_INDUSTRY_CORE})\\b` +
    `|\\b(?:${_LAND_INDUSTRY_CORE})\\b.{0,60}\\b(?:where|which\\s+land|free\\s+land|available|public\\s+land|open\\s+land|water\\s+land|soil\\s+land|space\\s+land|tier\\s*\\d+)\\b` +
    `|\\bfree\\s+(?:water|soil|grass|space|land)\\s+(?:land\\s+)?for\\b.{0,30}\\b(?:${_LAND_INDUSTRY_CORE}|stone|fish|metal|animal|pond)\\b` +
    `|\\bwhere\\s+can\\s+i\\s+(?:mine|chop|farm|fish|woodwork|cook|stoneshap|catch|bbq|forge|use\\s+(?:the\\s+|a\\s+)?(?:winery|windmill|textile|apiary|coop|slug|forge|anvil))\\b` +
    `|\\bsomewhere\\s+to\\s+(?:mine|chop|farm|fish|woodwork|cook|stoneshap|catch|bbq)\\b` +
    `|\\bland(?:s)?\\s+(?:free\\s+)?to\\s+(?:mine|chop|farm|fish|woodwork|cook|stoneshap|bbq)\\b` +
    `|\\bis\\s+there\\s+(?:a\\s+)?(?:free\\s+|public\\s+|open\\s+|ready\\s+|available\\s+)?lands?\\b` +
    `|\\bany\\s+(?:free|public|open|ready|available)\\s+lands?\\b` +
    `|\\bland\\s+that\\s+(?:is|are)\\s+(?:ready|free|available|open|public)\\b` +
    `|\\bready\\s+lands?\\b` +
    `|\\bfind\\s+(?:me\\s+)?(?:a\\s+)?(?:free\\s+|public\\s+|open\\s+|ready\\s+|available\\s+)?land\\b` +
    `|\\bfree\\s+land\\b` +
    `|\\b(?:free|public|open|ready|available)\\s+ponds?\\b` +
    `|\\blands?\\s+with(?:\\s+a)?\\s+(?:free\\s+|public\\s+|open\\s+)?ponds?\\b` +
    `|\\bfind\\s+(?:me\\s+)?(?:a\\s+)?(?:free\\s+)?pond\\b` +
    `|\\bpond\\s+(?:that\\s+(?:is|are)\\s+)?(?:free|ready|available|open|public)\\b` +
    `|\\bis\\s+there\\s+(?:a\\s+)?(?:free\\s+|public\\s+|open\\s+)?pond\\b` +
    // tier + land-type shorthand: "tier 4 soil", "tier 2 farming", "farm tier 2"
    `|\\btier\\s*\\d+\\s+(?:soil|grass|water|space|farm(?:ing)?)\\b` +
    `|\\b(?:soil|grass|water|space)\\s+tier\\s*\\d+\\b`,
    "i"
  );

// Short follow-up after a clarification prompt — "mine tier 3", "chop tier 2", "fish"
const LAND_FOLLOWUP_RE =
  /^\s*(?:i(?:'d)?\s+(?:want|like)\s+to\s+|let'?s?\s+)?(?:mine|mining|woodwork(?:ing)?|forestry|chop(?:ping)?|trees?|logs?|farm(?:ming)?|cook(?:ing)?|bbq|stoneshaping?|kiln|fish(?:ing)?|metalwork(?:ing)?|animalcare|petcare|catch(?:ing)?|ponds?|winery|windmill|textile|apiary|coop|slug)\b/i;

// Skill XP recipe fast path — "what should I craft to level Stoneshaping",
// "how do I level up stoneshaping", "best woodwork recipe for me", "level up mining"
const SKILL_XP_SKILLS_RE = "stoneshaping|mining|farming|cooking|forestry|metalwork(?:ing)?|woodwork(?:ing)?|fish(?:ing)?|petcare|business|exploration|stone|metal|animal\\s+care|animals?";
// "recipe" + common misspellings: receipe, recipie, recepie, woodworking
const RECIPE_WORD_RE = "rec(?:ipe|eipe|ipie|epie)s?";
const SKILL_XP_RE = new RegExp(
  // 1. "best/good/top [skill] recipe/recipes/crafting"
  `\\b(?:best|good|top|recommended?)\\s+(?:${SKILL_XP_SKILLS_RE})\\s+(?:${RECIPE_WORD_RE}|craft(?:ing)?)(?:\\s+(?:for|to)\\s+(?:me|level))?\\b` +
  // 2. "recipes for/to level [skill]" (includes misspellings)
  `|\\b(?:${RECIPE_WORD_RE})\\s+(?:for|to\\s+level)\\s+(?:${SKILL_XP_SKILLS_RE})\\b` +
  // 3. Original action-word patterns: "what should i craft to level [skill]", "level up [skill]" etc.
  `|\\b(?:what\\s+should\\s+i\\s+craft\\s+to\\s+level|what\\s+(?:${RECIPE_WORD_RE}|craft|item)s?\\s+(?:give|gives?|best\\s+for)\\s+(?:the\\s+most\\s+)?xp|best\\s+(?:${RECIPE_WORD_RE}|craft|item)\\s+(?:for|to)\\s+(?:level(?:ing)?(?:\\s+up)?|gain\\s+xp)|most\\s+xp\\s+(?:from|for|in)|best\\s+xp\\s+(?:ratio|per\\s+energy|${RECIPE_WORD_RE}|craft)(?:\\s+for)?|to\\s+level(?:\\s+up)?|how\\s+(?:do\\s+i|can\\s+i|to)\\s+level\\s+(?:up\\s+)?(?:my\\s+)?|level\\s+up\\s+(?:my\\s+)?|how\\s+(?:do\\s+i|can\\s+i)\\s+(?:get\\s+)?(?:more\\s+)?(?:xp\\s+(?:in|for)\\s+)?|faster\\s+(?:way\\s+)?to\\s+level)\\b.{0,50}\\b(?:${SKILL_XP_SKILLS_RE})\\b` +
  // 4. "[skill] [xp/leveling] motivation"
  `|\\b(?:${SKILL_XP_SKILLS_RE})\\b.{0,50}\\b(?:xp|leveling?|level\\s+up|best\\s+craft|most\\s+xp|faster|quickly)\\b` +
  // 5. "[skill] [misspelled recipe]" — "best woodwork receipe for me"
  `|\\b(?:best|good|top)\\s+(?:${SKILL_XP_SKILLS_RE})\\s+(?:${RECIPE_WORD_RE})\\b`,
  "i"
);

const SKILL_CANON: Record<string, string> = {
  stoneshaping: "stoneshaping", stone: "stoneshaping",
  mining: "mining", mine: "mining",
  farming: "farming", farm: "farming",
  cooking: "cooking", cook: "cooking",
  forestry: "forestry", trees: "forestry", chopping: "forestry", chop: "forestry", logging: "forestry",
  woodworking: "woodwork", woodwork: "woodwork", wood: "woodwork",
  metalworking: "metalworking", metalwork: "metalworking", metal: "metalworking", smithing: "metalworking",
  fishing: "exploration", fish: "exploration", exploration: "exploration",
  petcare: "petcare", animalcare: "petcare", "animal care": "petcare", animals: "petcare",
  business: "business",
};

const SKILL_DISPLAY_NAMES: Record<string, string> = {
  woodwork:     "Woodworking",
  petcare:      "Animal Care",
  metalworking: "Metalworking",
  forestry:     "Forestry",
  farming:      "Farming",
  mining:       "Mining",
  stoneshaping: "Stoneshaping",
  cooking:      "Cooking",
  exploration:  "Exploration",
  business:     "Business",
};

function detectSkillXpQuery(q: string): { rawSkill: string; canonicalSkill: string } | null {
  const lq = q.toLowerCase();
  if (!SKILL_XP_RE.test(lq)) return null;
  for (const [alias, canon] of Object.entries(SKILL_CANON)) {
    if (lq.includes(alias)) return { rawSkill: alias, canonicalSkill: canon };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reverse recipe fast path — "what can I make with X", "what uses X"
// ---------------------------------------------------------------------------

const REVERSE_RECIPE_RE =
  /\bwhat\s+can\s+i\s+(?:make|craft|cook|brew|bake)\s+with\b|\bwhat\s+uses?\s+[a-z]|\bwhat\s+is\s+.+?\s+used\s+for\b|\brec(?:ipe|eipe|ipie|epie)s?\s+(?:with|using|that\s+uses?)\s+[a-z]/i;

function detectReverseRecipeIngredient(q: string): string | null {
  const lq = q.toLowerCase().replace(/[?!.,;:'"]+/g, " ").trim();
  let m: RegExpMatchArray | null;
  m = lq.match(/\bwhat\s+can\s+i\s+(?:make|craft|cook|brew|bake)\s+with\s+(.+)$/);
  if (m) return m[1].trim();
  m = lq.match(/\bwhat\s+uses?\s+(.+)$/);
  if (m) return m[1].trim();
  m = lq.match(/\bwhat\s+is\s+(.+?)\s+used\s+for\b/);
  if (m) return m[1].trim();
  m = lq.match(/\brecipes?\s+(?:with|using|that\s+uses?)\s+(.+)$/);
  if (m) return m[1].trim();
  return null;
}

function findRecipesByIngredient(ingredientName: string): CatalogRow[] {
  const safe = ingredientName.replace(/[%_\\]/g, "\\$&");
  // Simple substring match — avoids trailing-quote bug (JSON ends with ']', not '"')
  return db.prepare<[string]>(`
    SELECT * FROM game_catalog
    WHERE lower(recipe_inputs) LIKE lower(?)
      AND is_event_recipe = 0
    ORDER BY level_required ASC, display_name ASC
    LIMIT 20
  `).all(`%${safe}%`) as CatalogRow[];
}

// Cost-to-make question — "how much does it cost to make X", "how much to craft X"
const COST_TO_MAKE_RE =
  /\bhow\s+much\s+(?:does?\s+it\s+cost|will\s+it\s+cost|would\s+it\s+cost)\s+to\s+(?:make|craft|brew|cook|bake)\s+/i;

// Cost follow-up — "how much will that cost" / "how much does that cost" (uses lastItemContextMap)
// Tolerates typos: "howm much", "how mutch", "what will that cost", "how much is that"
const COST_FOLLOWUP_RE =
  /\b(?:how|howm)\s+m[ua][tc][ck]?h?\s+(?:does?\s+|will\s+|would\s+|is\s+)?(?:that|this|it)\b|\bhow\s+much\s+(?:does?\s+|will\s+|would\s+)?(?:that|this|it)\s+(?:cost|going\s+to\s+cost|will\s+cost)\b|\bhow\s+much\s+will\s+that\s+cost\b|\bwhat\s+(?:will|would|does?)\s+(?:that|this|it)\s+cost\b|\bhow\s+much\s+is\s+(?:that|it|this)\b/i;

// "How much does X cost" — show market price + craft cost. Must NOT match "it/that/this/they/those".
const ITEM_PRICE_RE =
  /\bhow\s+much\s+(?:does?\s+|do\s+)?(?!(?:it|that|this|they|those|each)\b)(.{3,60}?)\s+cost\b/i;

// Candidate-list price follow-up — "how much do they cost" after a candidates answer (uses lastCandidateListMap)
const CANDIDATE_PRICE_RE =
  /\bhow\s+much\s+(?:do\s+they|does\s+each|are\s+they|do\s+those|are\s+those)\s+(?:cost|go\s+for)\b|\bhow\s+much\s+(?:is|are)\s+(?:each|they|those)\b|\bprice\s+(?:of|for)\s+(?:them|those|each)\b|\bwhich\s+(?:one\s+)?is\s+(?:cheapest|best\s+value|best\s+deal)\b/i;

// Item attribute question — "how much energy/XP/time to craft X", "how long does it take to make X"
// Must be checked BEFORE guide routing so item-specific questions don't fall into the Energy guide.
const ITEM_ATTR_RE =
  /\bhow\s+(?:much\s+(?:energy|xp|experience)|long\b).{0,80}\b(?:to\s+(?:craft|make|brew|cook|bake)|from\s+(?:making|crafting)|(?:does?\s+it|will\s+it)\s+take\s+to\s+(?:make|craft))\b/i;

type ItemAttr = "energy" | "xp" | "time";

function detectItemAttrQuery(q: string): { attrs: ItemAttr[]; itemFragment: string } | null {
  const lq = q.toLowerCase().replace(/[?!.,;:'"]+/g, " ").trim();
  if (!ITEM_ATTR_RE.test(lq)) return null;

  const attrs: ItemAttr[] = [];
  if (/\benergy\b/.test(lq)) attrs.push("energy");
  if (/\bxp\b|\bexperience\b/.test(lq)) attrs.push("xp");
  if (/\bhow\s+long\b|\btime\b/.test(lq)) attrs.push("time");
  if (attrs.length === 0) return null;

  // Extract item name: everything after "to (craft|make|brew|cook|bake) [a/an/the] "
  // or "from (making|crafting) [a/an/the] "
  let m = lq.match(/\bto\s+(?:craft|make|brew|cook|bake)\s+(?:a\s+|an\s+|the\s+)?(.+?)(?:\?|\s*$)/);
  if (!m) m = lq.match(/\bfrom\s+(?:making|crafting)\s+(?:a\s+|an\s+|the\s+)?(.+?)(?:\?|\s*$)/);
  if (!m) m = lq.match(/\btake\s+to\s+(?:make|craft)\s+(?:a\s+|an\s+|the\s+)?(.+?)(?:\?|\s*$)/);
  if (!m) return null;
  const itemFragment = m[1].trim().replace(/\?+$/, "").trim();
  if (!itemFragment) return null;
  return { attrs, itemFragment };
}

// Resolve "tier N <name>" or "tN <name>" from the catalog using the tier column + name LIKE.
// For known tool types (axe/pickaxe/shears), also matches by item_id prefix since display names vary.
function resolveTieredItemId(fragment: string): string | null {
  const m = fragment.match(/^(?:tier\s+(\d+)|t(\d+))\s+(.+)$/i);
  if (!m) return null;
  const tierNum = parseInt(m[1] || m[2], 10);
  const baseName = m[3].trim().replace(/[%_]/g, "").toLowerCase();

  // Known tool type → item_id prefix map
  const toolIdPrefix: Record<string, string> = {
    axe: "itm_axe_%", pickaxe: "itm_pickaxe_%", pick: "itm_pickaxe_%", shears: "itm_shears_%",
  };
  const toolPrefix = toolIdPrefix[baseName] ?? null;

  const rows = toolPrefix
    ? db.prepare<unknown[]>(
        `SELECT item_id FROM game_catalog
         WHERE tier = ? AND (lower(display_name) LIKE ? OR item_id LIKE ?)
         ORDER BY CASE WHEN item_id LIKE 'itm_dura%' THEN 1 ELSE 0 END ASC, is_event_recipe ASC, item_id ASC LIMIT 3`
      ).all(tierNum, `%${baseName}%`, toolPrefix) as { item_id: string }[]
    : db.prepare<unknown[]>(
        `SELECT item_id FROM game_catalog
         WHERE tier = ? AND lower(display_name) LIKE ?
         ORDER BY CASE WHEN item_id LIKE 'itm_dura%' THEN 1 ELSE 0 END ASC, is_event_recipe ASC, item_id ASC LIMIT 3`
      ).all(tierNum, `%${baseName}%`) as { item_id: string }[];

  return rows.length > 0 ? rows[0].item_id : null;
}

function formatMinutes(mins: number | null): string {
  if (mins === null) return "unknown time";
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.round(mins)} min`;
}

// Extract land-finder params from a query string
function parseLandReadyQuery(q: string): {
  industry: string | null;
  tier: number | null;
  landType: string | null;
} {
  const lq = q.toLowerCase();

  // Industry — includes pond/catch as fishing aliases, bbq, winery, windmill, textile, apiary, coop, slug, petcare
  const industryMatch = lq.match(/\b(mine|mining|woodwork|woodworking|forestry|chop(?:ping)?|trees?|logs?|farm(?:ming)?|cook(?:ing)?|stoneshapin?g?|kiln|fish(?:ing)?|metalwork(?:ing)?|forge|anvil|animalcare|animal\s+care|petcare|pet\s+care|ponds?|catch(?:ing)?|bbq|barb[ae]cue|winery|wine|windmill|textile(?:\s+mill)?|apiary|bee|coop|chicken\s+coop|slug(?:\s+ranch)?|soil|grass)\b/);
  const rawIndustry = industryMatch ? industryMatch[1].replace(/\s+/g, "") : null;
  const industry = rawIndustry ? resolveIndustry(rawIndustry) : null;

  // Tier
  const tierMatch = lq.match(/\btier\s*(\d+)\b/);
  const tier = tierMatch ? parseInt(tierMatch[1], 10) : null;

  // Land type — only match explicit land type words the player named — "land" alone is ambiguous.
  // "soil" and "grass" resolve industry→farm but do NOT restrict land type (soil exists on all land types).
  // Match "water"/"space" alone, or "grass land"/"soil land" when the player explicitly names the type.
  const typeMatch = lq.match(/\b(water|space)\b|\b(grass|soil|land)\s+land\b/);
  const landType = typeMatch ? resolveLandType(typeMatch[1] ?? typeMatch[2]) : null;

  return { industry, tier, landType };
}

// Questions where injecting computed taskboard/stacked opportunities is relevant.
// For any other question (guides, item info, features) the section just confuses the model.
const OPPORTUNITIES_RELEVANT_RE =
  /\b(?:earn|make|get)\s+(?:more\s+)?(?:coins?|pixels?)|\bhow\s+(?:do\s+i|to|can\s+i)\s+(?:earn|make|get)\b|\bbest\s+way\s+to\b|\bwhat\s+should\s+i\b|\bwhat\s+can\s+i\s+do\b|\bwhat\s+to\s+(?:do|work|focus|craft)\b|\btaskboard\b|\bstacked\s+offer|\bstrateg\w*|\bdo\s+today\b|\bwhere\s+do\s+i\s+start\b|\bbest\s+(?:order|move|action|task)\b|\bwhat\s+to\s+work\b/i;

// Tips question detector — broad generic tips, but not "tips for crafting X" etc.
const TIPS_RE =
  /\btips?\b|\bhints?\b|\bsuggestions?\b|\badvice\b|\bhow\s+(?:can\s+i|to)\s+play\s+(?:the\s+game\s+)?better\b|\bhow\s+can\s+i\s+(?:get\s+better|improve|play\s+better)\b|\bany\s+(?:tips?|hints?|advice|boosts?|suggestions?)\b|\bboosts?\s+(?:for|to\s+help|in)\b|\bdo\s+you\s+have\s+(?:any\s+)?(?:tips?|hints?|advice|suggestions?)\b|\bare\s+there\s+(?:any\s+)?(?:tips?|hints?|boosts?|suggestions?)\b/i;

function isTipsQuery(q: string): boolean {
  if (!TIPS_RE.test(q)) return false;
  // Exclude topic-specific phrases: "tips for X", "tips on X", "tips about X" (not "tips for me/you/my")
  if (/\btips?\s+(?:for|on|about|when|how)\s+(?!(?:me|my|you|us)\b)/i.test(q)) return false;
  // Exclude directed activity: "tips to earn/make/farm/..." but allow "tips to play better"
  if (/\btips?\s+to\s+(?:earn|make|get\s+more|farm|grind|trade|buy|sell|complete|win|beat|unlock|improve\s+my|boost\s+my)\b/i.test(q)) return false;
  if (/\badvice\s+(?:on|about|for)\s/i.test(q)) return false;
  return true;
}

// Tip topic keywords (must match data/tips.json topic values with spaces for compound topics).
const TIP_TOPIC_MAP: Record<string, string> = {
  boost: "boosts",
  boosts: "boosts",
  gameplay: "gameplay",
  daily: "daily-routine",
  routine: "daily-routine",
  "daily routine": "daily-routine",
};

function pickTips(question: string, playerId: string | null): string {
  const all = listAllTips();
  if (all.length === 0) return "No tips available right now.";

  // Try to match a topic from the question
  const lq = question.toLowerCase();
  let matchedTopic: string | undefined;
  for (const [key, val] of Object.entries(TIP_TOPIC_MAP)) {
    if (lq.includes(key)) { matchedTopic = val; break; }
  }

  let pool = matchedTopic ? all.filter(t => t.topic === matchedTopic) : all;
  if (pool.length === 0) pool = all;

  // Rotate daily per player for variety
  const day = Math.floor(Date.now() / 86_400_000);
  const salt = playerId ? playerId.charCodeAt(0) : 0;
  const offset = (day + salt) % pool.length;
  const count = Math.min(5, pool.length);
  const picked: typeof pool = [];
  for (let i = 0; i < count; i++) {
    picked.push(pool[(offset + i) % pool.length]);
  }
  return picked.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
}

// Guide question detector.
function detectGuideId(question: string): string | null {
  // Strip punctuation to tolerate "how do i hatch an egg?" etc.
  const lq = question.toLowerCase().replace(/[?!.,;:'"]+/g, " ");
  // Item attribute questions win over guide routing — "how much energy to craft X" is not the Energy guide.
  if (ITEM_ATTR_RE.test(lq)) return null;
  // Hearth Hall guide
  if (
    /\bhearth\s*hall\b/.test(lq) &&
    /\b(?:explain|tell|what\s+is|how\s+does|how\s+do|guide|overview|work|faction|offering|sabotage|reactor)\b/.test(lq)
  ) return "hearth_hall";
  // Neon Zone individual games — checked before generic neon_zone so a single-game question
  // returns only that game's entry, not the full overview.
  if (/\bliving\s+labyrinth\b/.test(lq)) return "living_labyrinth";
  if (/\bsquish\s+the\s+fish\b|\bsquish\s+fish\b/.test(lq)) return "squish_the_fish";
  if (/\bbunny\s+baiter\b/.test(lq)) return "bunny_baiter";
  if (/\bveggie\s+vexer\b/.test(lq)) return "veggie_vexer";
  if (/\bhigher\s+lower\b/.test(lq)) return "higher_lower";
  if (/\bda\s+bomb\b/.test(lq)) return "da_bomb";
  // Generic Neon Zone overview
  if (
    /\bneon\s*zone\b/.test(lq) ||
    /\bzonez\s*tokens?\b|\bstuff\s+stubs?\b/.test(lq) ||
    (/\b(?:which|what)\s+(?:game|games?)\b/.test(lq) && /\bneon|zone|tokens?\b/.test(lq))
  ) return "neon_zone";
  // Energy guide
  if (
    /\b(?:how\s+(?:do\s+i|can\s+i|to)\s+(?:get|restore|refill|regenerate|regen)\s+(?:more\s+)?energy\b|how\s+does\s+energy\s+(?:work|regen|regenerate)|energy\s+(?:cap|max|regen|regeneration|restore|drink|drinks)|sauna\s+(?:rocks?|pool)|how\s+much\s+energy|sleep\s+(?:for\s+energy|restore)|more\s+energy)\b/.test(lq) ||
    (/\benergy\b/.test(lq) && /\bhow\b|\bmore\b|\brestore\b|\bregen\b|\bsauna\b|\bsleep\b|\bcap\b|\bdrink\b|\bvip\b/.test(lq))
  ) return "energy";
  // Fishing guide
  if (
    /\bhow\s+(?:do\s+i\s+|can\s+i\s+|to\s+)?fish\b|\bhow\s+does\s+fishing\s+work\b/.test(lq) ||
    /\bfishing\s+(?:rod|pond|guide|skill|level|spot|tips?)\b|\bfish\s+pond\b|\bwhere\s+(?:to\s+|can\s+i\s+)?fish\b/.test(lq) ||
    /\bhigher[\s-]tier\s+fish\b|\bhow\s+(?:do\s+i\s+|can\s+i\s+)?(?:catch|get)\s+(?:higher|better|bigger)\s+fish\b/.test(lq) ||
    /\bfishing\s+(?:rod\s+tier|rod\s+level)\b|\bexploration\s+(?:xp|level|skill)\b/.test(lq) ||
    (/\bfishing\b/.test(lq) && /\bhow\b|\bwhere\b|\bwhat\b|\bguide\b|\bpond\b|\brod\b/.test(lq))
  ) return "fishing";
  // Tools guide
  if (
    /\btool\s+(?:tier|uses?|durability|wears?\s+out|break|upgrade|level)\b|\btools?\s+(?:wear\s+out|break|upgrade)\b/.test(lq) ||
    /\bhow\s+(?:do\s+tools?\s+work|many\s+uses\s+does|do\s+i\s+upgrade\s+(?:my\s+)?(?:axe|pickaxe|shears?))\b/.test(lq) ||
    /\b(?:axe|pickaxe|shears?)\s+(?:tier|uses?|break|wear|upgrade|level)\b/.test(lq) ||
    (/\b(?:axe|pickaxe|shears?|watering\s+can)\b/.test(lq) && /\btier\b|\buse|\bbreak|\bwear|\bupgrade\b|\bcraft\b|\bnext\b/.test(lq)) ||
    /\bwhat\s+tier\s+(?:tool|axe|pickaxe|shears?)\b|\bnext\s+tier\s+tool\b|\bupgrade\s+(?:my\s+)?(?:axe|pickaxe|shears?|tool)\b/.test(lq) ||
    /\bhow\s+(?:do\s+i\s+|can\s+i\s+)?get\s+(?:a\s+)?(?:better|higher[\s-]tier|next[\s-]tier)\s+(?:axe|pickaxe|shears?|tool)\b/.test(lq) ||
    /\b(?:better|higher[\s-]tier|next[\s-]tier)\s+(?:axe|pickaxe|shears?|tool)\b/.test(lq)
  ) return "tools";
  // Potions / Alchemic Forge guide
  if (
    /\b(?:speed|luck|strength)\s+potion\b/.test(lq) ||
    /\b(?:where|how)\s+(?:do\s+i\s+|can\s+i\s+|to\s+)?(?:make|craft|get)\s+(?:a\s+)?potion\b/.test(lq) ||
    /\bpotion\s+table\b/.test(lq) ||
    /\bincuvite\b/.test(lq) ||
    (/\bpotion\b/.test(lq) && /\bhow\b|\bwhere\b|\bmake\b|\bcraft\b|\bforge\b/.test(lq)) ||
    /\balchemic\s+forge\b|\balchemy\s+forge\b/.test(lq) ||
    /\b(?:speed|yield)\s+boost\b/.test(lq) ||
    /\bboost\s+potion\b|\bboost\s+(?:for|to)\s+(?:farming|forestry|mining|cooking|metalwork|fishing|stoneshap|woodwork|winery|animal\s*care)\b/.test(lq) ||
    /\bmore\s+durable\s+(?:tool|axe|pickaxe|shears?)\b/.test(lq)
  ) return "potions";
  // Movement speed guide
  if (
    /\b(?:how\s+(?:do\s+i\s+|can\s+i\s+|to\s+)?(?:move|run|walk)\s+faster)\b/.test(lq) ||
    /\b(?:move|run|walk|movement)\s+(?:speed|faster|quick)\b/.test(lq) ||
    /\bfaster\s+(?:movement|speed|avatar)\b/.test(lq) ||
    /\brunning\s+shoes?\b|\bsneakers?\b/.test(lq) ||
    /\b(?:how\s+(?:do\s+i\s+|can\s+i\s+|to\s+)?)?go\s+faster\b|\bgo\s+fast\b/.test(lq) ||
    /\bbe\s+(?:quicker|faster)\b/.test(lq) ||
    (/\bspeed\b/.test(lq) && /\bmove|run|walk|avatar|player\b/.test(lq))
  ) return "movement";
  // Animal feeding questions — route before other animal care checks so "how do I feed" never hits LLM
  if (
    /\bhow\s+(?:do\s+i\s+|to\s+)?feed\b|\bwhat\s+do\s+(?:\w+\s+)?eat\b|\bwhat\s+(?:do\s+)?(?:cows?|pigs?|ducks?|goats?|chickens?|bees?|slugs?|silk\s*slugs?|dragons?)\s+eat\b/.test(lq) ||
    /\bfeed(?:ing)?\s+(?:my\s+)?(?:animal|cow|pig|duck|goat|chicken|bee|slug|silk\s*slug|dragon)s?\b/.test(lq) ||
    /\banimal\s+feed\b|\bfeeding\s+animals?\b/.test(lq) ||
    /\bapimix\b|\bfarmamix\b|\balgamix\b|\bmystic\s*mix\b/.test(lq) ||
    /\bmoo\s*munch\b/.test(lq)
  ) return "animal_care";
  // Animal Care guide — general "explain" or specific sub-questions
  if (
    (/\banimal\s*care\b/.test(lq) &&
      /\b(?:explain|tell|what\s+is|how\s+does|how\s+do|guide|overview|work)\b/.test(lq)) ||
    /\bhow\s+(?:do\s+i\s+)?hatch\b|\bhatch(?:ing)?\s+(?:an?\s+)?eggs?\b|\bhatching\b|\bincubators?\b/.test(lq) ||
    /\bbaby\s+animals?\b|\bbaby\s+(?:animal|creature|pet)s?\b|\bget\s+(?:a\s+)?baby\b|\bbabies\b/.test(lq) ||
    /\bgathering\s+basket\b|\bwhat\s+does\s+a\s+baby\b|\bhow\s+(?:do\s+i\s+)?get\s+(?:a\s+)?baby\b/.test(lq)
  ) return "animal_care";
  // VIP guide
  if (
    /\bvip\b/.test(lq) &&
    /\b(?:benefit|good|worth|tier|perk|work|explain|what\s+is|how\s+does|how\s+do|get|buy|cost|price|guide|overview|energy|fee|marketplace|subscription|pass|active|subscribe)\b/.test(lq)
  ) return "vip";
  if (/\b(?:is\s+vip\s+(?:good|worth)|vip\s+benefits?|what\s+does\s+vip\s+do|vip\s+tiers?|vip\s+perks?|how\s+(?:do\s+i|to)\s+get\s+vip|buy\s+vip|vip\s+pass)\b/.test(lq)) return "vip";
  // Reputation guide
  if (
    /\b(?:reputation|trust\s+score|cred\s+credit|how\s+(?:do\s+i|to)\s+(?:get|increase|build|improve)\s+(?:more\s+)?(?:rep(?:utation)?|trust)|what\s+is\s+(?:my\s+)?(?:rep(?:utation)?|trust\s+score)|what(?:'s|\s+is)\s+(?:a\s+)?trust\s+score)\b/.test(lq)
  ) return "reputation";
  if (/\b(?:my\s+rep\b|my\s+reputation\b|my\s+trust\s+score\b)\b/.test(lq)) return "reputation";
  return null;
}

// For guide sub-questions, return only the paragraphs relevant to the question.
function extractGuideSection(content: string, question: string): string {
  const paragraphs = content.split(/\n\n+/);
  if (paragraphs.length <= 1) return content;
  const lq = question.toLowerCase().replace(/[?!.,;:'"]+/g, " ");

  const isEggQuestion = /\bhatch|\begg\b|\bincubators?\b|\bpotion\b/.test(lq);
  const isBabyQuestion = /\bbaby\s+animals?\b|\bbabies\b|\bwhat\s+does\s+a\s+baby|\bbasket\b/.test(lq);
  const isFeedQuestion =
    /\bfeed|\bapimix\b|\bfarmamix\b|\balgamix\b|\bmystic\s*mix\b|\bmoo\s*munch\b|\bwhat\s+do\s+\w+\s+eat|\bchoco\s+sauce\b/.test(lq);

  if (isFeedQuestion) {
    // Return the feeding paragraph(s). If question names a specific animal, include only that animal's bullet line
    // plus the paragraph header so the answer is self-contained.
    const feedParagraphs = paragraphs.filter(p => p.toLowerCase().includes("apimix") || p.toLowerCase().includes("farmamix") || p.toLowerCase().includes("algamix") || p.toLowerCase().includes("mystic mix") || p.toLowerCase().includes("moomunch") || p.toLowerCase().includes("moo munch") || p.toLowerCase().includes("choco sauce") || p.toLowerCase().includes("chicken feed"));
    if (feedParagraphs.length > 0) {
      // Named animal filter: narrow lines within the feed paragraph
      const animalMatch = lq.match(/\b(cow|pig|duck|goat|chicken|bee|slug|silk\s*slug|dragon)s?\b/);
      if (animalMatch) {
        const animal = animalMatch[1].replace(/\s+/g, " ");
        const narrowed = feedParagraphs.map(p => {
          const lines = p.split("\n");
          const header = lines[0];
          const matched = lines.filter(l => l.toLowerCase().includes(animal) || !l.startsWith("-"));
          return matched.join("\n");
        }).filter(p => p.trim());
        if (narrowed.length > 0) return narrowed.join("\n\n");
      }
      return feedParagraphs.join("\n\n");
    }
  }

  if (!isEggQuestion && !isBabyQuestion) return content;

  const keywords = isEggQuestion
    ? ["hatch", "egg", "incubator", "potion"]
    : ["baby", "hatch", "incubat"];

  const relevant = paragraphs.filter(p =>
    keywords.some(kw => p.toLowerCase().includes(kw))
  );
  return relevant.length > 0 ? relevant.join("\n\n") : content;
}

// ---------------------------------------------------------------------------
// Game feature names — prevent item resolution when query is about a feature.
// ---------------------------------------------------------------------------

const GAME_FEATURE_PHRASES = new Set([
  "stacked app", "stacked offers", "stacked offer",
  "taskboard", "task board",
  "hearth hall", "neon zone",
  "marketplace",
  "diary", "notebook", "shopping list",
  "faction", "guild",
  "animal care",
  "baby animal", "baby animals", "hatch egg", "hatch eggs", "hatching eggs",
  "incubator", "incubators", "gathering basket", "potion table",
  "animal feed", "feeding animals", "feed my", "feed an animal",
  "apimix", "farmamix", "algamix", "mystic mix", "moomunch", "moo munch",
  "neon zone", "zonez tokens", "stuff stubs", "living labyrinth", "squish the fish",
  "bunny baiter", "veggie vexer", "higher lower", "da bomb",
  "fishing rod", "fish pond", "fishing pond", "fishing guide",
  "energy drink", "sauna rocks", "sauna pool",
  "tool tier", "tool wears", "tool uses", "tool upgrade", "watering can",
  "higher tier fish", "exploration xp", "exploration level",
  "better axe", "better pickaxe", "better shears", "better tool",
  "next tier axe", "next tier pickaxe", "next tier shears",
  "higher tier axe", "higher tier pickaxe", "higher tier shears",
]);

// Single-word feature tokens that shouldn't be resolved as items.
const GAME_FEATURE_WORDS = new Set([
  "stacked", "taskboard", "marketplace", "diary", "notebook", "faction", "guild",
  "reputation", "vip",
]);

// Synonyms → canonical item_id (display names don't match common player phrasing)
const ITEM_ALIASES: Record<string, string> = {
  "running shoes": "itm_runningShoe_basic",
  "running shoe":  "itm_runningShoe_basic",
  "speed shoes":   "itm_runningShoe_basic",
  "speed shoe":    "itm_runningShoe_basic",
  "genesis runners": "itm_runningShoe_basic",
  "silk":          "itm_silkfiber",
};

// Generic queries that map to multiple items — answered inline, never "Did you mean?"
const DIRECT_MULTI_ANSWERS: Record<string, string> = {
  milk: "Milk comes from three animals: Cow Milk (Cows, tier 1), Goat Milk (Goats, tier 2 — Animal Care level 20), Pig Milk (Pigs, tier 2 — Animal Care level 20).",
};

// Only offer a fuzzy "Did you mean?" suggestion when the query looks like an item name.
// Queries made entirely of generic English words (stopwords) should not get a fuzzy suggestion.
const FUZZY_STOPWORDS = new Set([
  "any", "the", "a", "an", "some", "my", "get", "give", "more", "help",
  "hint", "hints", "tip", "tips", "advice", "suggest", "suggestions", "suggestion",
  "what", "how", "can", "do", "is", "are", "me", "for", "to", "in", "about",
  "rep", "reputation", "play", "better", "improve", "good", "vip",
]);
function looksLikeItemQuery(query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  return tokens.some(t => !FUZZY_STOPWORDS.has(t));
}

function isGameFeatureQuestion(query: string): boolean {
  const lq = query.toLowerCase();
  for (const phrase of GAME_FEATURE_PHRASES) {
    if (lq.includes(phrase)) return true;
  }
  const words = lq.split(/\s+/);
  // "stacked app", "stacked offers" etc. are phrases above.
  // For single-word queries (e.g. bare "taskboard"), check the feature words set.
  if (words.length <= 2 && words.some((w) => GAME_FEATURE_WORDS.has(w))) return true;
  return false;
}

// Standing instructions — voice instruction is injected per-persona.
function buildStandingInstructions(voiceInstruction: string): string {
  return `Standing guidance (apply with judgment, not mechanically):

Persona, tone and formatting:
- Respond in plain text only — no markdown, no asterisks, no bullet points, no headers.
- Answer in 2–4 short sentences. Be concise.
- ${voiceInstruction}
- Never open with "Please note", "You possess", "Please indicate", or "Please be advised" — drop those phrases entirely.
- For strategy questions: lead with Stacked offers and Taskboard orders that pay best or expire soonest. Never add filler like "maintain your current routine" or "keep doing what you're doing".
- When describing a Taskboard order or crafting opportunity, use the format "costs ~X to fill, pays Y" — never say "saves X coins". Flag when fill cost is over the player's limit.

Use injected ground-truth data, do not reason it out yourself:
- Weakest skills: if a "Weakest skills (ground truth)" line is present in the player context, use those exact skill names when mentioning skill balance — never compare the full level list yourself. If no such line is present, skip skill-balance advice entirely. Frame it as a helpful observation, not nagging; skip if not relevant.
- Computed opportunities: when a "Computed opportunities" section is present, treat those numbers as ground truth — never invent alternative costs, rewards, or feasibility for taskboard/stacked items when this data is available.
- Item data: when an "Item data from game library" section is present, treat those crafting recipes and harvest sources as ground truth. Use them to answer questions about how to obtain or craft an item. Never contradict this data or substitute guesses from your training knowledge.
- Resource access: when an item entry contains an "Obtained by" line, that is the computed ground truth for how the item is obtained, the player's skill access, and their tool situation. Report it directly — never tell the player to "check your skill level" or "check if you have the right tool" when this data is present. If the data shows the skill is unlocked and the tool is sufficient, confirm that plainly. If something is missing (level too low, wrong tool tier, no tool), state exactly what is needed. CRITICAL: if the "Obtained by" line contains ✗ for skill level or tool, the player CANNOT currently do this action. Lead with that plainly — name the skill, the required level, and the player's current level, all taken directly from the "Obtained by" line. Never say "you have the required level" or imply the player can do this when any ✗ is present in the resource-access data. Skill requirements for gathering/farming/mining come ONLY from the resource-access "Obtained by" line — never from the "Weakest skills" line or the player's general skill levels.
- Crafting math: when a "Crafting math" section is present, use those exact numbers — do not recalculate, do not multiply values yourself. State the total quantities directly from the section.
- Currency flows: when a "Currency flows" section is present, it is the ONLY authoritative source for how currencies are earned and converted. Never contradict it, combine it with training knowledge, or invent a conversion path not listed there.

Conditional behaviors:
- Coin earning: when the player asks how to make or earn more Coins AND a "Computed opportunities" section is present, LEAD your response with the specific TASKBOARD ORDERS and their Coin rewards — do not open with generic advice. The computed data is the direct answer.
- Taskboard orders: if the player asks about affording or producing an item for a Taskboard-style order, check whether their current skill levels actually allow crafting it. If they can't craft it yet, say plainly that they'd need to buy it instead rather than craft it.
- Stacked vs taskboard: STACKED APP OFFERS and TASKBOARD ORDERS are always in separate labeled sections. Never call a Stacked App offer a "taskboard order". Stacked offers pay Pixels; taskboard orders pay Coins.
- Only reference wiki facts that are directly relevant to what the player actually asked. If a wiki entry matched by keyword but doesn't genuinely apply to the question or the player's situation, ignore it rather than working it in.
- Stacked / Taskboard personal queries: when the player is asking about THEIR OWN current Stacked App offers or Taskboard orders and those lists are present in the context, skip any generic explanation of what the Stacked App or Taskboard is — go straight to their specific items and what to do with them.
- Higher Lower (Neon Zone): never suggest or recommend Higher Lower as a way to earn tokens, Pixels, or anything else. It is unlimited plays per day but pure luck — each try costs tokens. If a Stacked App offer specifically requires Higher Lower, state the reward and the risk plainly (e.g. "520 Pixels if you guess 20 in a row — pure luck, each try costs tokens; set a limit before you start") without recommending it.

Hard factual constraints — never make these claims:
- The player's skill levels shown are their CURRENT levels, not maximums or caps — never imply they should "level up to" their current number, and never invent a cap.
- If energy is provided as a plain number only (no max shown), the player's energy cap is unknown — do not suggest resting, sleeping, or waiting for energy to regenerate based on assumptions about the cap.
- Never claim skills, crafting, leveling, marketplace sales, farming, or mining directly produce or buy Pixels — only the three sources in the how_pixels_are_earned wiki entry ever grant Pixels (Stacked App, HearthHall, Neon Zone). Never suggest converting Coins, Buoy Bucks, or items into Pixels, or buying Pixels with Coins — the Coins→Pixels direction does not exist. These activities earn Coins and XP only.
- Never claim Merchant Boat Contracts pay Pixels. They pay 200–375 Buoy Bucks, 3,000 Business XP, and 15,000–20,000 Coins per order — no Pixels.
- Never state that an item requires a specific land type (Water, Grass, Space) unless the item data in the current context explicitly includes that land type. If no land type is present in the data, omit any land-type claim entirely.
- Never interpret a balance figure as a market price.
- Never combine or blend facts from two different wiki entries into a single new claim that neither entry actually states — e.g. never say 'guild members running Merchant Boat Contracts' unless a wiki entry explicitly connects those two things. Each cited fact must trace back to exactly one source (a wiki entry, the player's real context data, or a Computed opportunities section) — never synthesize a new relationship between two unrelated facts.
- Never describe HearthHall as a steady, reliable, or passive income source.
- Never claim Stacked App reward amounts scale with player level unless the Stacked data in the current context explicitly states the amounts.
- Always use the name "Merchant Boat Contracts", never "Merchant Ships".

When no fast-path data covers the question:
- Do not invent item names, recipe steps, drop rates, order rewards, coin amounts, or game mechanics not present in the injected data above.
- If the ground truth in the current context does not contain the specific answer, reply briefly: "I'm not sure about that one yet — try asking me where to get an item, how to make something, how to earn coins or Pixels, or for tips." Max 3 sentences, no invented details.`;
}

// ---------------------------------------------------------------------------
// Opportunities section — formats computeBestActions output for the prompt
// ---------------------------------------------------------------------------

function formatOpportunitiesSection(result: BestActionsResult): string | null {
  if (result.immediateWins.length === 0 && result.nearTermOpportunities.length === 0) {
    return null;
  }

  const lines: string[] = [
    "Computed opportunities (already calculated — do not recalculate or guess):",
  ];

  // Split by type so the model cannot conflate stacked offers with taskboard orders.
  const taskboardWins = result.immediateWins.filter((w) => w.type === "taskboard");
  const stackedWins   = result.immediateWins.filter((w) => w.type === "stacked_offer");

  if (taskboardWins.length > 0) {
    lines.push("", "TASKBOARD ORDERS ready to deliver (reward: Coins — these are taskboard deliveries, NOT Stacked offers):");
    for (const win of taskboardWins) {
      lines.push(`- ${win.detail}`);
    }
  }

  if (stackedWins.length > 0) {
    lines.push("", "STACKED APP OFFERS eligible now (reward: Pixels — do NOT describe these as taskboard orders):");
    for (const win of stackedWins) {
      lines.push(`- ${win.detail}`);
    }
  }

  if (result.nearTermOpportunities.length > 0) {
    lines.push("", "TASKBOARD ORDERS not yet deliverable (items still needed):");
    for (const opp of result.nearTermOpportunities) {
      const label = `${opp.itemName}${opp.tier ? ` (${opp.tier})` : ""}`;
      lines.push(`- ${label}: ${opp.detail}`);
    }
  }

  if (result.notes.length > 0) {
    lines.push("", "Calculation notes:");
    for (const note of result.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
}

function formatCacheMetadata(player: AskContext["player"]): string | null {
  if (!player) return null;
  const now = Date.now();
  const lines: string[] = [];

  const tbCapturedAt = numOrNull(player.taskboardCapturedAt);
  const tbExpiresAt  = numOrNull(player.taskboardExpiresAt);
  if (tbCapturedAt !== null) {
    const ageMin = Math.round((now - tbCapturedAt) / 60_000);
    let note =
      ageMin <= 1
        ? "Taskboard snapshot: live"
        : `Taskboard snapshot: captured ${ageMin} min ago`;
    if (tbExpiresAt !== null) {
      const leftMs = tbExpiresAt - now;
      if (leftMs <= 0) {
        note += " (board has since refreshed — data may be stale)";
      } else {
        const h = Math.floor(leftMs / 3_600_000);
        const m = Math.floor((leftMs % 3_600_000) / 60_000);
        note += `, refreshes in ${h > 0 ? `${h}h ` : ""}${m}m`;
      }
    }
    lines.push(note);
  }

  const stCapturedAt = numOrNull(player.stackedOffersCapturedAt);
  if (stCapturedAt !== null) {
    const ageMin = Math.round((now - stCapturedAt) / 60_000);
    lines.push(
      ageMin <= 1
        ? "Stacked offers snapshot: live"
        : `Stacked offers snapshot: captured ${ageMin} min ago`,
    );
  }

  // Flag offers expiring within 1 hour as urgent.
  const offers = Array.isArray(player.stackedOffers)
    ? (player.stackedOffers as any[])
    : [];
  for (const offer of offers) {
    const expiresAt = numOrNull(offer?.expiresAt);
    if (expiresAt !== null) {
      const leftMs = expiresAt - now;
      if (leftMs > 0 && leftMs < 3_600_000) {
        const m = Math.round(leftMs / 60_000);
        const label =
          (typeof offer.requirementText === "string" && offer.requirementText) ||
          (typeof offer.description === "string" && offer.description) ||
          "Stacked offer";
        lines.push(
          `URGENT: offer "${label}" expires in ~${m} min — recommend claiming immediately if eligible`,
        );
      }
    }
  }

  return lines.length > 0 ? `Data freshness:\n${lines.join("\n")}` : null;
}

// Station ID → land industry for Fix 10 ("where can I make X" → public land search)
const STATION_INDUSTRY_MAP: Record<string, string> = {
  textile_mill: "textile",  textilemill: "textile",
  kiln: "stone",            stoneshaping_kiln: "stone",  stoneshaping: "stone",
  cooking_fire: "cook",     campfire: "cook",             stove: "cook",
  bbq: "bbq",               bbq_station: "bbq",
  anvil: "metalwork",       forge: "metalwork",
  workbench: "woodwork",    carpentry_bench: "woodwork",
  windmill: "windmill",
  apiary: "apiary",
  coop: "coop",             chicken_coop: "coop",
  slug_ranch: "slug",       slugranch: "slug",
  winery: "wine",           wine_press: "wine",
};

function stationToIndustry(stationId: string | null | undefined): string | null {
  if (!stationId) return null;
  const key = stationId.toLowerCase().replace(/\s+/g, "_");
  return STATION_INDUSTRY_MAP[key] ?? null;
}

// Post-process a fast answer: replace [[FIND_PUBLIC_LANDS:type]] with actual land list (Fix 13)
// and appends land list for "where can I make X" when station industry is known (Fix 10).
async function enrichFastAnswer(
  rawAnswer: string,
  catalogRow: { item_id: string; category: string | null; recipe_station: string | null; level_required: number | null } | null,
  question: string,
  guildHandle?: string | null,
): Promise<string> {
  let answer = rawAnswer;

  // Fix 13: resolve [[FIND_PUBLIC_LANDS:type:industry]] marker
  // Format: [[FIND_PUBLIC_LANDS:water:mine]] or [[FIND_PUBLIC_LANDS:space:farm]]
  // Industry is optional — defaults to "farm" for backwards compat.
  // landType from the marker may be "grass" (from LAND_LOCKED_ITEMS) — resolve to "land"
  // so the SQL query matches the DB value stored by the land-report extension.
  const MARKER_RE = /\s*[Uu]se \[\[FIND_PUBLIC_LANDS:(\w+)(?::(\w+))?\]\] to find[^.]*\.?/;
  const markerMatch = answer.match(MARKER_RE);
  if (markerMatch) {
    const rawLandType  = markerMatch[1];
    const markerIndustry = markerMatch[2] ?? "farm";
    const resolvedLandType = resolveLandType(rawLandType) ?? rawLandType;
    try {
      const lands = await findReadyLands({ industry: markerIndustry, landType: resolvedLandType, limit: 5, guildHandle: guildHandle ?? undefined });
      const landList = formatReadyLandsAnswer({ lands, industry: markerIndustry, landType: resolvedLandType, totalInDB: 0 });
      answer = answer.replace(MARKER_RE, ` ${landList}`);
    } catch {
      answer = answer.replace(MARKER_RE, ` Search for public ${rawLandType} lands with ${markerIndustry} spots.`);
    }
  }

  // Fix 10: "where can I make X" — append public lands with that station
  const isMakeQuery = /\bwhere\s+can\s+i\s+make\b|\bwhere\s+do\s+i\s+(?:make|craft)\b|\bwhere\s+can\s+i\s+craft\b/i.test(question);
  if (isMakeQuery && catalogRow?.recipe_station) {
    const industry = stationToIndustry(catalogRow.recipe_station);
    if (industry) {
      try {
        const lands = await findReadyLands({ industry, limit: 5, guildHandle: guildHandle ?? undefined });
        const landList = formatReadyLandsAnswer({ lands, industry, totalInDB: 0 });
        answer += `\n\n${landList}`;
      } catch {
        // land search failed — skip
      }
    }
  }

  return answer;
}

async function buildPrompt(
  question: string,
  wikiEntries: WikiEntry[],
  ctx?: AskContext,
  craftingMathSection?: string | null,
): Promise<{ prompt: string; debug: Record<string, string> }> {
  const wikiSection =
    wikiEntries.length > 0
      ? wikiEntries.map((e) => `[topic: ${e.topic}]\n${e.content}`).join("\n\n")
      : "(No relevant wiki entries found.)";

  const contextSection = formatContext(ctx);

  // Upcoming milestones + ready-entity summary — built in parallel, both
  // use the shared 60 s library cache so at most one upstream fetch.
  // Extension sends 'skills'; fall back to legacy 'levels' field.
  const rawLevelMap =
    ctx?.player?.skills !== undefined || ctx?.player?.levels !== undefined
      ? extractLevels(ctx.player.skills ?? ctx.player.levels)
      : {};
  // Normalize to lowercase so skill keys from the Colyseus levelMap ("Farming", "Mining", etc.)
  // match the lowercase keys used by computeResourceAccess.
  const levelMap = Object.fromEntries(
    Object.entries(rawLevelMap).map(([k, v]) => [k.toLowerCase(), v])
  );

  // Active player goals — fetched from DB when walletAddress is present.
  const wallet = strOrNull(ctx?.walletAddress);
  const activeGoals = wallet ? listActiveGoals(wallet) : [];
  const goalsSection =
    activeGoals.length > 0
      ? `Player's current goals:\n${activeGoals.map((g) => `- ${g.goal_text}`).join("\n")}`
      : null;

  // Compute strategy opportunities when the extension has sent live taskboard
  // or stacked-offers snapshots AND the question is about earnings/strategy/taskboard.
  // Skipping it for unrelated questions (guides, item info) prevents the model from
  // mixing taskboard item names into irrelevant answers.
  const p = ctx?.player;
  const hasTaskboard     = Array.isArray(p?.taskboard)     && (p!.taskboard     as unknown[]).length > 0;
  const hasStackedOffers = Array.isArray(p?.stackedOffers) && (p!.stackedOffers as unknown[]).length > 0;
  const shouldComputeOpportunities =
    (hasTaskboard || hasStackedOffers) && OPPORTUNITIES_RELEVANT_RE.test(question);

  const [upcomingSection, readySection, opportunitiesSection, itemDataSection] = await Promise.all([
    Object.keys(levelMap).length > 0 ? buildUpcomingSection(levelMap) : Promise.resolve(null),
    Array.isArray(ctx?.nearbyEntities) || (ctx?.marketPrices && Object.keys(ctx.marketPrices).length > 0)
      ? buildReadyEntitiesSection(
          Array.isArray(ctx?.nearbyEntities) ? ctx!.nearbyEntities : [],
          ctx?.marketPrices,
          levelMap,
        )
      : Promise.resolve(null),
    shouldComputeOpportunities
      ? computeBestActions({
          taskboard:     p?.taskboard,
          stackedOffers: p?.stackedOffers,
          energy:        p?.energy,
          energyMax:     p?.energyMax,
          inventory:     p?.inventory,
          skills:        p?.skills ?? p?.levels,
          playerId:      typeof p?.playerId === "string" ? p.playerId : undefined,
          authToken:     typeof p?._authToken === "string" ? p._authToken : undefined,
          marketPrices:  p?.marketPrices && typeof p.marketPrices === "object"
            ? (p.marketPrices as Record<string, { lowestPrice: number; quantity: number }>)
            : undefined,
          factionId:     typeof p?.factionId === "number" ? (p.factionId as number) : undefined,
          sabotageCount: (() => {
            const fid = typeof p?.factionId === "number" ? (p.factionId as number) : null;
            if (!fid || !p?.inventory || typeof p.inventory !== "object" || Array.isArray(p.inventory)) return undefined;
            const chests = p?.storageChests && typeof p.storageChests === "object"
              ? (p.storageChests as Record<string, { items?: Array<{ itemId: string; qty: number }> }>) : null;
            return computeSabotageCount(fid, p.inventory as Record<string, unknown>, chests).total;
          })(),
        })
          .then(formatOpportunitiesSection)
          .catch(() => null)
      : Promise.resolve(null),
    findItemsInQuestion(
      question,
      p?.inventory && typeof p.inventory === "object" && !Array.isArray(p.inventory)
        ? Object.fromEntries(
            Object.entries(p.inventory as Record<string, unknown>).flatMap(([k, v]) =>
              typeof v === "number" ? [[k, v]] : [],
            ),
          )
        : undefined,
      Object.keys(levelMap).length > 0 ? levelMap : undefined,
    ).then(formatItemDataSection).catch(() => null),
  ]);

  const sociability =
    ctx?.sociabilityLevel !== undefined ? numOrNull(ctx.sociabilityLevel) : null;
  const sociabilityInstruction =
    sociability !== null && sociability >= 1 && sociability <= 4
      ? `Keep your response ${SOCIABILITY_LABELS[sociability]}.`
      : null;

  const STRATEGY_KEYWORDS = /\b(strateg|personali[sz]|what should i|earn|earning|best action|best move|what to do|what can i do)\b/i;
  const noLiveDataNote =
    STRATEGY_KEYWORDS.test(question) && !hasTaskboard && !hasStackedOffers
      ? "IMPORTANT: The player's Taskboard and Stacked App panels are currently closed, so you have no visibility into their actual current orders or offers. You MUST open your response by telling the player to open their Taskboard and Stacked App panels so you can see what's actually available — do this before offering any other advice. Do not give generic strategy tips as a substitute for this."
      : null;

  const coinEarningNote =
    COIN_EARNING_RE.test(question) && opportunitiesSection
      ? "IMPORTANT: The player is asking how to earn more Coins. The Computed opportunities section above lists their specific current Taskboard orders and coin rewards — LEAD your response with those exact orders. Do not open with generic coin-earning advice; the player's actual options are already computed."
      : null;

  const currencyFlowsSection =
    CURRENCY_KEYWORDS_RE.test(question) ? CURRENCY_FLOWS_CONTENT : null;

  const cacheMetaSection = formatCacheMetadata(p);

  const hasContext = contextSection || goalsSection || upcomingSection || readySection || opportunitiesSection || cacheMetaSection || noLiveDataNote || coinEarningNote || currencyFlowsSection;

  const persona = resolvePersona(ctx?.persona);
  const personaIntro = PERSONA_INTROS[persona];
  const standingInstructions = buildStandingInstructions(PERSONA_VOICE[persona]);

  const parts = [
    personaIntro,
    "",
    standingInstructions,
    "",
    "Relevant wiki information:",
    "---",
    wikiSection,
    "---",
  ];

  if (itemDataSection) {
    parts.push("", itemDataSection);
  }

  // Ground-truth weakest skills — only inject when the question is about skill
  // balance or leveling; never for item/crafting/farming questions where the
  // model might misuse it to invent skill requirements.
  const isStrategyQuestion = Object.keys(levelMap).length >= 3 && SKILL_BALANCE_RE.test(question);
  const weakestSkillsLine = isStrategyQuestion ? computeWeakestSkills(levelMap) : null;
  const strategyFactsBlock = isStrategyQuestion ? buildStrategyFactsBlock(ctx, levelMap) : null;

  if (contextSection) {
    const ctxBlock = weakestSkillsLine
      ? `${contextSection}\n${weakestSkillsLine}`
      : contextSection;
    parts.push("", "Current player context:", "---", ctxBlock, "---");
  }

  if (goalsSection) {
    parts.push("", goalsSection);
  }

  if (upcomingSection) {
    parts.push("", upcomingSection);
  }

  if (readySection) {
    parts.push("", readySection);
  }

  if (opportunitiesSection) {
    parts.push("", opportunitiesSection);
  }

  if (cacheMetaSection) {
    parts.push("", cacheMetaSection);
  }

  if (noLiveDataNote) {
    parts.push("", noLiveDataNote);
  }

  if (coinEarningNote) {
    parts.push("", coinEarningNote);
  }

  if (currencyFlowsSection) {
    parts.push("", currencyFlowsSection);
  }

  if (strategyFactsBlock) {
    parts.push("", "Player strategy facts:", "---", strategyFactsBlock, "---");
  }

  if (craftingMathSection) {
    parts.push("", craftingMathSection);
  }

  const strategyInstructions = strategyFactsBlock
    ? "Answer in up to 5 short numbered points. Plain text only — no ** or # markdown. Each point must name a real item, offer, skill, or order from the Player strategy facts above. Lead with the single best action for today. End within 5 points — never cut off mid-sentence. Never call a skill high or low unless the sorted list above confirms it."
    : null;

  parts.push(
    "",
    `Player question: ${question}`,
    "",
    strategyInstructions
      ? strategyInstructions
      : sociabilityInstruction
        ? `${sociabilityInstruction} Answer helpfully based on the wiki information${hasContext ? " and the player's current context" : ""} provided.`
        : `Answer helpfully and concisely based on the wiki information${hasContext ? " and the player's current context" : ""} provided.`,
  );

  // Build debug map: each injected section name → truncated text (1500 chars).
  const truncate = (s: string, max = 1500): string =>
    s.length > max ? s.slice(0, max) + "…[truncated]" : s;
  const debug: Record<string, string> = {};
  if (itemDataSection)      debug.itemData        = truncate(itemDataSection);
  if (craftingMathSection)  debug.craftingMath    = truncate(craftingMathSection);
  if (goalsSection)         debug.goals           = truncate(goalsSection);
  if (upcomingSection)      debug.upcoming        = truncate(upcomingSection);
  if (readySection)         debug.readyEntities   = truncate(readySection);
  if (opportunitiesSection) debug.opportunities   = truncate(opportunitiesSection);
  if (cacheMetaSection)     debug.cacheMeta       = truncate(cacheMetaSection);
  if (noLiveDataNote)       debug.noLiveDataNote  = noLiveDataNote;
  if (coinEarningNote)      debug.coinEarningNote = coinEarningNote;
  if (currencyFlowsSection) debug.currencyFlows   = truncate(currencyFlowsSection);
  if (strategyFactsBlock)   debug.strategyFacts   = truncate(strategyFactsBlock);

  return { prompt: parts.join("\n"), debug };
}

// Strip <think>...</think> blocks that some models (qwen3, Gemini) emit before the answer.
function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
}

// Strip markdown formatting characters (**bold**, __bold__, *italic*, _italic_, # headings, `code`)
// so answers render as plain text in the chat bubble.
function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/__(.+?)__/gs, "$1")
    .replace(/\*(.+?)\*/gs, "$1")
    .replace(/_(.+?)_/gs, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .trim();
}

// ---------------------------------------------------------------------------
// Post-generation validator — removes sentences matching known bad claims
// ---------------------------------------------------------------------------

// BannedPattern supports either a RegExp (fast path) or a function tester
// (for negation-aware or directional checks that can't be expressed as a
// single regex without catastrophic backtracking).
type BannedPatternTester = RegExp | ((segment: string) => boolean);

const BANNED_PATTERNS: Array<{ id: string; pattern: BannedPatternTester }> = [
  // -----------------------------------------------------------------------
  // Unified invalid-currency-conversion validator.
  //
  // Catches any sentence claiming currency A converts / exchanges / is sold
  // for currency B, UNLESS:
  //   (a) negation is present anywhere in the sentence, OR
  //   (b) the direction is the legitimate Pixels → Coins trade.
  //
  // Six test sentences:
  //   PASS  "You can use Pixels to buy Coins (500k = 30 Pixels)."
  //   PASS  "Buoy Bucks cannot be converted into Coins or Pixels."
  //   PASS  "Spend your Pixels in the Pixel Shop to get Coins."
  //   CAUGHT "Buoy Bucks can be converted into Coins."
  //   CAUGHT "You can exchange Buoy Bucks for Coins at the shop."
  //   CAUGHT "Coins can be turned into Pixels through the marketplace."
  // -----------------------------------------------------------------------
  {
    id: "invalid_currency_conversion",
    pattern: (seg: string): boolean => {
      // (a) Negation anywhere in the sentence — assume a "you can't" statement.
      if (/\b(?:not|n't|never|cannot|can't|won't|no\s+(?:way|path|conversion))\b/i.test(seg)) return false;
      // (b) Valid direction: Pixels being spent to acquire Coins.
      if (/\bpixels?\b.{0,80}\b(?:buy|purchase|exchange|spend|use|get|obtain)\b.{0,80}\bcoins?\b/i.test(seg)) return false;
      if (/\bcoins?\b.{0,40}\b(?:with|using)\b.{0,40}\bpixels?\b/i.test(seg)) return false;
      // Catch: sentence contains a conversion verb (any inflection) AND [currency → preposition → currency].
      // Split into two tests so verb order relative to currencies doesn't matter.
      const hasConversionVerb = /\b(?:convert(?:s|ed|ing)?|exchange(?:s|d|ing)?|sell(?:s|ing)?|sold|buy(?:s|ing)?|bought|purchase(?:s|d|ing)?|turn(?:s|ed|ing)?\s+into|transform(?:s|ed|ing)?)\b/i.test(seg);
      const hasCurrencyChain = /\b(?:buoy\s+bucks?|coins?|pixels?)\b.{0,120}\b(?:into|to|for|with)\b.{0,120}\b(?:buoy\s+bucks?|coins?|pixels?)\b/i.test(seg);
      return hasConversionVerb && hasCurrencyChain;
    },
  },
  // Marketplace / crafting / farming earns Pixels
  {
    id: "marketplace_earns_pixels",
    pattern: /\b(?:marketplace|crafting?|farming?|mining)\b.{0,80}(?:earn|earns?|yield|gives?|produce|generates?)\b.{0,60}\bpixels?\b/i,
  },
  // Deprecated name
  {
    id: "merchant_ships",
    pattern: /\bmerchant\s+ships?\b/i,
  },
  // Merchant Boat Contracts do not pay Pixels.
  // Requires BOTH an earning verb AND "pixel(s)" in the same sentence, with no
  // negation (not, n't, never, no longer) between the merchant-boat anchor and
  // the pixel claim.  [^.\n] keeps the match within one sentence.
  {
    id: "merchant_boat_earns_pixels",
    pattern: /\bmerchant\s+(?:boat|contract)s?\b(?!(?:[^.\n]){0,150}(?:\bnot\b|n't|\bnever\b|no\s+longer\b))(?:[^.\n]){0,150}\b(?:earn|pay|give|reward|yield)s?\b(?:[^.\n]){0,80}\bpixels?\b/i,
  },
  // HearthHall as steady income
  {
    id: "hearthall_steady",
    pattern: /\bhearthall\b.{0,150}\b(?:steady|reliable|consistent|regular|passive)\b/i,
  },
];

interface Violation {
  timestamp: number;
  ruleId: string;
  removed: string;
}

const recentViolations: Violation[] = [];
const MAX_VIOLATIONS_LOGGED = 100;

const NUMBERED_ITEM_RE = /^\d+[\.\)]\s/;

/**
 * Removes sentences that match any banned pattern from the model's reply.
 * Operates line-by-line then sentence-by-sentence so list items and prose
 * are both handled. Never retries — removal is always faster than a re-call.
 *
 * Extra numbered-list hygiene:
 *  1. If the lead sentence of a numbered item is removed and only a thin
 *     fragment (< 10 words, no subject) survives, the whole item is dropped.
 *  2. After removals, remaining numbered items are renumbered sequentially
 *     so the list stays coherent.
 */
function validateAnswer(answer: string): string {
  const lines = answer.split("\n");
  const keptLines: string[] = [];

  for (const line of lines) {
    const isNumberedItem = NUMBERED_ITEM_RE.test(line.trim());

    // Split into sentences; list items are typically one sentence but prose may have more.
    const segments = line.split(/(?<=[.!?])\s+/);
    const keptSegments: string[] = [];

    for (const segment of segments) {
      let banned = false;
      for (const { id, pattern } of BANNED_PATTERNS) {
        const matched = typeof pattern === "function" ? pattern(segment) : pattern.test(segment);
        if (matched) {
          const entry: Violation = {
            timestamp: Date.now(),
            ruleId: id,
            removed: segment.trim().slice(0, 300),
          };
          recentViolations.unshift(entry);
          if (recentViolations.length > MAX_VIOLATIONS_LOGGED) recentViolations.pop();
          console.warn(
            `[validateAnswer] rule="${id}" removed: "${segment.trim().slice(0, 150)}"`,
          );
          banned = true;
          break;
        }
      }
      if (!banned) keptSegments.push(segment);
    }

    let keptLine = keptSegments.join(" ").trim();

    // Drop orphaned numbered-item fragments: if the original line was a numbered
    // list item, something was removed, and the first surviving segment no longer
    // starts with the list number (meaning the labeled lead sentence was stripped),
    // discard the whole line if the remaining content is thin (< 10 words).
    if (keptLine && isNumberedItem && keptSegments.length < segments.length) {
      const firstKeptHasNumber =
        keptSegments.length > 0 && NUMBERED_ITEM_RE.test(keptSegments[0].trim());
      if (!firstKeptHasNumber) {
        const wordCount = keptLine.split(/\s+/).length;
        if (wordCount < 10) {
          keptLine = "";
        }
      }
    }

    if (keptLine) keptLines.push(keptLine);
  }

  // Renumber sequential numbered list items after any removals.
  // Counter resets on non-empty non-list lines (i.e. between separate lists).
  let listCounter = 0;
  const renumbered = keptLines.map((line) => {
    if (NUMBERED_ITEM_RE.test(line)) {
      listCounter++;
      return line.replace(/^\d+/, String(listCounter));
    }
    if (line.trim() !== "") listCounter = 0;
    return line;
  });

  return renumbered.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Invented-item detector — rejects LLM answers that name non-existent catalog items
// in recipe/crafting claim context ("craft X", "X requires Y", etc.)
// ---------------------------------------------------------------------------

// Game feature names and currencies that are not catalog items.
const KNOWN_NON_ITEMS = new Set([
  "animal care", "hearth hall", "stacked app", "merchant boat contracts",
  "merchant boat", "neon zone", "buoy bucks", "business xp", "farmers market",
  "golden icon", "vip tier", "gathering basket", "gathering baskets",
  "coin reward", "pixel reward",
]);

function inventedItemsInAnswer(answer: string): boolean {
  if (countCatalogRows() === 0) return false; // catalog not built yet — skip check

  // Patterns that assert an item name exists in a crafting/recipe context.
  const patterns: RegExp[] = [
    /\b(?:craft(?:ed|ing)?|make|build|creat(?:e|ing)|recipe\s+for)\s+(?:a\s+)?([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,4})/g,
    /\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){1,4})\s+(?:requires?|needs?)\b/g,
  ];

  for (const re of patterns) {
    for (const m of answer.matchAll(re)) {
      const name = (m[1] ?? "").trim();
      if (name.length < 5) continue;
      if (KNOWN_NON_ITEMS.has(name.toLowerCase())) continue;
      // Use strict distance (1) so only near-exact matches pass.
      const match = fuzzyResolveName(name, 1);
      if (!match) {
        console.warn(`[inventedItems] rejected: "${name}" not in catalog`);
        return true;
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Shopping-list intent detection + handler
// ---------------------------------------------------------------------------

interface ShoppingListIntent {
  kind: "add" | "add-context" | "remove" | "list";
  rawText: string;
  /** Parsed quantity from "add 51 X to my list" — null when not specified. */
  explicitQty: number | null;
}

function detectShoppingListIntent(question: string): ShoppingListIntent | null {
  // "add those items / them / these ingredients to my shopping list" — resolves last recipe context
  if (
    /\b(?:add|put|place)\s+(?:those\s+(?:items?|ingredients?)|them|these\s+(?:items?|ingredients?))\b/i.test(question) &&
    /shopping[\s-]?list/i.test(question)
  ) {
    return { kind: "add-context", rawText: "__context__", explicitQty: null };
  }

  // "add/put/place [N] X to/on (my) shopping list"
  const addM = question.match(
    /\b(?:add|put|place)\s+(?:(\d+)\s+)?(.+?)\s+(?:to|on)\s+(?:(?:my|the)\s+)?(?:shopping[\s-]?list)\b/i,
  );
  if (addM) {
    const explicitQty = addM[1] ? parseInt(addM[1], 10) : null;
    return { kind: "add", rawText: addM[2].trim(), explicitQty };
  }

  // "remove/delete/take off X from (my/the) shopping list"
  const remM = question.match(
    /\b(?:remove|delete|take\s+off)\s+(.+?)\s+(?:from\s+)?(?:(?:my|the)\s+)?(?:shopping[\s-]?list)\b/i,
  );
  if (remM) return { kind: "remove", rawText: remM[1].trim(), explicitQty: null };

  // "what's on my shopping list" / "show my shopping list"
  if (
    /(?:what(?:'s|\s+is|\s+are)\s+on|show|see|view|check)\s+(?:(?:my|the)\s+)?shopping[\s-]?list|what(?:'s|\s+is)\s+on\s+(?:my\s+)?(?:shopping[\s-]?list|list)/i.test(
      question,
    )
  ) {
    return { kind: "list", rawText: "", explicitQty: null };
  }

  return null;
}

interface CraftingQuery {
  targetItemText: string;
  quantity: number;
}

function detectCraftingQuery(question: string): CraftingQuery | null {
  // "to make/craft/cook/brew 51 X" — capture everything up to punctuation or end
  const m = question.match(
    /\bto\s+(?:make|craft|cook|brew|produce)\s+(\d+)\s+([\w][\w\s-]*)(?:\s*[,.]|\s*$)/i,
  );
  if (m) {
    const qty = parseInt(m[1], 10);
    if (qty > 0) return { quantity: qty, targetItemText: m[2].trim() };
  }
  return null;
}

async function handleShoppingListAction(
  question: string,
  intent: ShoppingListIntent,
  playerId: string | null,
): Promise<{ answer: string; debug: Record<string, string> } | null> {
  let allItems: Record<string, any>;
  let allAchievements: Record<string, any>;
  let nameMap: Record<string, string>;
  try {
    [allItems, allAchievements, nameMap] = await Promise.all([
      fetchItems() as Promise<Record<string, any>>,
      fetchAchievements() as Promise<Record<string, any>>,
      fetchLocaleNameMap(),
    ]);
  } catch {
    return null; // game library unavailable — fall through to LLM
  }

  const harvestMap = buildHarvestMap(allItems, nameMap);

  // "add those items / them" — resolve last recipe's ingredients from context
  if (intent.kind === "add-context") {
    if (!playerId) return { answer: "I can't access your shopping list — player ID not available.", debug: {} };
    const lastCtx = lastItemContextMap.get(playerId);
    if (!lastCtx || !lastCtx.ingredients || lastCtx.ingredients.length === 0 || Date.now() - lastCtx.timestamp > LAST_ITEM_TTL) {
      return { answer: "I'm not sure which items you mean — ask about a recipe first, then say 'add those items to my shopping list'.", debug: {} };
    }
    const added: string[] = [];
    for (const ing of lastCtx.ingredients) {
      if (ing.name && ing.qty > 0) {
        insertShoppingItem(playerId, ing.name, ing.qty);
        added.push(`${ing.qty}× ${ing.name}`);
      }
    }
    if (added.length === 0) return { answer: "No ingredients found for the last recipe.", debug: {} };
    return {
      answer: `Added to your shopping list (ingredients for ${lastCtx.displayName}): ${added.join(", ")}.`,
      debug: { addedFromContext: added.join(", ") },
    };
  }

  // "what's on my list"
  if (intent.kind === "list") {
    if (!playerId) return { answer: "I can't access your shopping list — player ID not available.", debug: {} };
    const items = listShoppingItems(playerId);
    if (items.length === 0) return { answer: "Your shopping list is empty.", debug: {} };
    const formatted = items.map((i) => `${i.quantity}× ${i.text}`).join(", ");
    return { answer: `Shopping list: ${formatted}.`, debug: { shoppingList: formatted } };
  }

  // "remove X from my list"
  if (intent.kind === "remove") {
    if (!playerId) return { answer: "I can't access your shopping list — player ID not available.", debug: {} };
    const items = listShoppingItems(playerId);
    const q = intent.rawText.toLowerCase();
    const match = items.find(
      (i) => i.text.toLowerCase().includes(q) || q.includes(i.text.toLowerCase()),
    );
    if (!match) return { answer: `"${intent.rawText}" is not on your shopping list.`, debug: {} };
    deleteShoppingItem(match.id, playerId);
    return { answer: `Removed ${match.quantity}× ${match.text} from your shopping list.`, debug: {} };
  }

  // "add X to my list"
  const craftingQuery = detectCraftingQuery(question);

  if (craftingQuery) {
    // Combined: "put X on my list, how many to make N Y"
    // Resolve the crafting target (Y), compute ingredients, find X in them
    const targetResult = resolveItemName(craftingQuery.targetItemText, nameMap, allItems, allAchievements);
    if (targetResult.kind === "found") {
      const bd = computeCraftingBreakdown(
        targetResult.itemId, craftingQuery.quantity,
        allItems, allAchievements, harvestMap, nameMap, {},
      );
      if (bd.craftable) {
        const shoppingText = intent.rawText.toLowerCase();
        // Find which ingredient matches the shopping list item
        const matchedIng = bd.directIngredients.find(
          (ing) =>
            ing.name.toLowerCase().includes(shoppingText) ||
            shoppingText.includes(ing.name.toLowerCase()),
        ) ?? (bd.rawLeaves.size > 0
          ? [...bd.rawLeaves.values()].find(
              (l) => l.name.toLowerCase().includes(shoppingText) || shoppingText.includes(l.name.toLowerCase()),
            )
          : null);

        const addQty = matchedIng
          ? ("qtyPerCraft" in matchedIng ? matchedIng.totalQty : (matchedIng as RecursiveLeaf).totalQuantity)
          : null;
        const addName = matchedIng ? matchedIng.name : intent.rawText;

        const mathLine = bd.directIngredients
          .map((ing) => `${ing.qtyPerCraft}×/craft × ${bd.craftsNeeded} crafts = ${ing.totalQty}× ${ing.name}`)
          .join("; ");
        const mathDebug = formatCraftingMathSection(bd, {});

        if (addQty !== null && playerId) {
          insertShoppingItem(playerId, addName, addQty);
          return {
            answer: `Added ${addQty}× ${addName} to your shopping list. (${bd.craftsNeeded} crafts of ${bd.targetItemName}: ${mathLine})`,
            debug: { craftingMath: mathDebug },
          };
        } else if (addQty !== null) {
          return {
            answer: `You need ${addQty}× ${addName} to make ${craftingQuery.quantity}× ${bd.targetItemName}. (${mathLine})\nNote: shopping list not saved — player ID not available.`,
            debug: { craftingMath: mathDebug },
          };
        }
      }
    }
    // Crafting target couldn't be resolved — fall through to plain add
  }

  // Plain add (no crafting query, or crafting query failed to match)
  const itemResult = resolveItemName(intent.rawText, nameMap, allItems, allAchievements);
  if (itemResult.kind !== "found") {
    // Try fuzzy suggestion
    const fuzzy = fuzzyResolveName(intent.rawText, 2);
    const suggestion = fuzzy ? ` Did you mean "${fuzzy.displayName}"?` : "";
    return {
      answer: `I couldn't find "${intent.rawText}" in the game catalog.${suggestion}`,
      debug: { notFound: intent.rawText },
    };
  }

  const qty = intent.explicitQty ?? 1;
  const bd = computeCraftingBreakdown(
    itemResult.itemId, qty,
    allItems, allAchievements, harvestMap, nameMap, {},
  );

  if (bd.craftable && bd.rawLeaves.size > 0) {
    // Add raw ingredients instead of the craftable item itself
    const addedLines: string[] = [];
    for (const [, leaf] of bd.rawLeaves) {
      if (playerId) insertShoppingItem(playerId, leaf.name, leaf.totalQuantity);
      addedLines.push(`${leaf.totalQuantity}× ${leaf.name}`);
    }
    return {
      answer: `Added to your shopping list (raw ingredients for ${qty}× ${bd.targetItemName}): ${addedLines.join(", ")}.`,
      debug: { craftingMath: formatCraftingMathSection(bd, {}) },
    };
  }

  // Raw/purchasable item — add directly
  const displayName = nameMap[itemResult.itemId] ?? intent.rawText;
  if (playerId) insertShoppingItem(playerId, displayName, qty);
  return {
    answer: `Added ${qty}× ${displayName} to your shopping list.`,
    debug: {},
  };
}

// ---------------------------------------------------------------------------
// Inventory query detection
// ---------------------------------------------------------------------------

interface InventoryQuery {
  itemText: string;
  kind: "count" | "have";
}

function detectInventoryQuery(question: string): InventoryQuery | null {
  // "how many X do i have" / "how many X in my storage/inventory/bag"
  const m1 = question.match(
    /\bhow\s+many\s+(.+?)\s+(?:do\s+i\s+(?:have|own)|(?:are?\s+)?in\s+(?:my\s+)?(?:inventory|storage|bag|pack))\b/i,
  );
  if (m1) return { itemText: m1[1].trim(), kind: "count" };
  // "how much X do i have"
  const m2 = question.match(/\bhow\s+much\s+(.+?)\s+do\s+i\s+have\b/i);
  if (m2) return { itemText: m2[1].trim(), kind: "count" };
  // "do i have any/enough X" / "do i have X"
  const m3 = question.match(
    /\bdo\s+i\s+have\s+(?:any\s+|enough\s+)?(.+?)(?:\s+in\s+(?:my\s+)?(?:inventory|storage|bag|pack))?\s*[?]?\s*$/i,
  );
  // Exclude "do i have X app/stacked" (game feature questions)
  if (m3) {
    const candidate = m3[1].trim();
    if (candidate && !isGameFeatureQuestion(candidate)) {
      return { itemText: candidate, kind: "have" };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Goal intent detection + handler
// ---------------------------------------------------------------------------

interface GoalIntent {
  kind: "add" | "remove" | "list" | "complete";
  rawText: string;
}

function detectGoalIntent(question: string): GoalIntent | null {
  // Add goal — must be checked BEFORE list so "add X to my goals" doesn't hit the list pattern.
  const addM = question.match(
    /\b(?:add|put|set)\s+(.+?)\s+to\s+(?:my\s+)?goals?\b/i,
  );
  if (addM) return { kind: "add", rawText: addM[1].trim() };

  const addGoalM = question.match(/\b(?:add|create)\s+goal:?\s+(.+)/i);
  if (addGoalM) return { kind: "add", rawText: addGoalM[1].trim() };

  // "i want to set a new goal", "can you add a goal for me", "make me a goal" — no target yet
  if (/\b(?:want\s+to\s+|can\s+you\s+|please\s+)?(?:set|add|make|create)\s+(?:a\s+)?(?:new\s+)?goals?\b/i.test(question) &&
      !/\bgoals?\s+(?:for|of)\s+.{3}/i.test(question)) {
    return { kind: "add", rawText: "" };
  }

  // List / view goals
  if (
    /\b(?:how\s+(?:are|is)\s+(?:my\s+)?goals?\s+(?:going|doing)|show|see|view|list|check)\b.*\bgoals?\b|\bgoals?\b.*\b(?:going|progress|update|status|check)\b/i.test(question) ||
    /\bwhat(?:'s|\s+is|\s+are)\b.*\bgoals?\b/i.test(question) ||
    /\bmy\s+goals?\b\s*[?]?\s*$/i.test(question)
  ) {
    return { kind: "list", rawText: "" };
  }

  // Remove goal
  const remM = question.match(
    /\b(?:remove|delete|take\s+off)\s+(.+?)\s+(?:from\s+(?:my\s+)?)?goals?\b/i,
  );
  if (remM) return { kind: "remove", rawText: remM[1].trim() };

  // Mark complete
  const doneM = question.match(
    /\b(?:mark|complete|finish)\s+(.+?)\s+(?:as\s+)?(?:done|complete|finished)\b/i,
  );
  if (doneM) return { kind: "complete", rawText: doneM[1].trim() };

  return null;
}

function parseSkillLevelGoal(text: string): { skill: string; targetLevel: number } | null {
  // "reach Stoneshaping 45" / "achieve Stoneshaping level 45"
  const m1 = text.match(/\b(?:reach|achieve|get\s+to)\s+(\w+)\s+(?:level\s+)?(\d+)\b/i);
  if (m1) return { skill: m1[1].toLowerCase(), targetLevel: parseInt(m1[2], 10) };
  // "Stoneshaping level 45"
  const m2 = text.match(/\b(\w+)\s+level\s+(\d+)\b/i);
  if (m2) return { skill: m2[1].toLowerCase(), targetLevel: parseInt(m2[2], 10) };
  // "level 45 on/in stoneshaping"
  const m3 = text.match(/\blevel\s+(\d+)\s+(?:on|in)\s+(\w+)\b/i);
  if (m3) return { skill: m3[2].toLowerCase(), targetLevel: parseInt(m3[1], 10) };
  return null;
}

async function handleGoalAction(
  intent: GoalIntent,
  playerId: string | null,
  playerSkillsWithExp?: Record<string, { level: number; totalExp: number | null }>,
): Promise<{ answer: string; debug: Record<string, string> }> {
  if (!playerId) {
    return { answer: "I can't access your goals — player ID not available.", debug: {} };
  }

  if (intent.kind === "list") {
    const goals = listNotebookGoals(playerId);
    if (goals.length === 0) {
      return { answer: "You have no goals set yet. Say \"add X to my goals\" to add one.", debug: {} };
    }
    const lines = goals.map((g, i) => `${i + 1}. ${g.text}${g.completed ? " ✓" : ""}`);
    const progressNotes: string[] = [];
    if (playerSkillsWithExp) {
      for (const g of goals) {
        if (g.completed) continue;
        const parsed = parseSkillLevelGoal(g.text);
        if (parsed) {
          const skillData = playerSkillsWithExp[parsed.skill];
          if (skillData !== undefined) {
            const cur = skillData.level;
            const pct = Math.min(100, Math.round((cur / parsed.targetLevel) * 100));
            if (skillData.totalExp != null) {
              const xpReq = skillTotalXpRequired(parsed.targetLevel);
              const xpLeft = Math.max(0, xpReq - skillData.totalExp);
              progressNotes.push(`${g.text}: level ${cur}/${parsed.targetLevel} (${pct}%) — ${xpLeft.toLocaleString()} XP remaining`);
            } else {
              progressNotes.push(`${g.text}: level ${cur}/${parsed.targetLevel} (${pct}%)`);
            }
          }
        }
      }
    }
    const progress = progressNotes.length > 0 ? "\n\nProgress:\n" + progressNotes.map(n => `• ${n}`).join("\n") : "";
    return { answer: `Your goals:\n${lines.join("\n")}${progress}`, debug: { goalCount: String(goals.length) } };
  }

  if (intent.kind === "add") {
    const goalText = intent.rawText;
    if (!goalText) return { answer: "What goal would you like to add?", debug: {} };
    if (/<[^>]+>/.test(goalText)) {
      console.log("[goals] placeholder unfilled:", goalText);
      return { answer: `I couldn't save that goal — it contains an unfilled placeholder ("${goalText}"). Please rephrase with a specific value.`, debug: { placeholderGoal: goalText } };
    }
    insertNotebookGoal(playerId, goalText);
    let progressNote = "";
    if (playerSkillsWithExp) {
      const parsed = parseSkillLevelGoal(goalText);
      if (parsed) {
        const skillData = playerSkillsWithExp[parsed.skill];
        if (skillData !== undefined) {
          const cur = skillData.level;
          if (skillData.totalExp != null) {
            const xpReq = skillTotalXpRequired(parsed.targetLevel);
            const xpLeft = Math.max(0, xpReq - skillData.totalExp);
            progressNote = ` — you need ${xpLeft.toLocaleString()} more XP (you're at level ${cur})`;
          } else {
            progressNote = ` (you're at level ${cur})`;
          }
        }
      }
    }
    return { answer: `Added goal: ${goalText}${progressNote}.`, debug: { goalAdded: goalText } };
  }

  if (intent.kind === "remove") {
    const goals = listNotebookGoals(playerId);
    const q = intent.rawText.toLowerCase();
    const match = goals.find(g => g.text.toLowerCase().includes(q) || q.includes(g.text.toLowerCase()));
    if (!match) return { answer: `"${intent.rawText}" is not in your goals.`, debug: {} };
    deleteNotebookGoal(match.id, playerId);
    return { answer: `Removed goal: ${match.text}.`, debug: {} };
  }

  if (intent.kind === "complete") {
    const goals = listNotebookGoals(playerId);
    const q = intent.rawText.toLowerCase();
    const match = goals.find(g => g.text.toLowerCase().includes(q) || q.includes(g.text.toLowerCase()));
    if (!match) return { answer: `"${intent.rawText}" is not in your goals.`, debug: {} };
    updateNotebookGoal(match.id, playerId, { completed: true });
    return { answer: `Marked as done: ${match.text}.`, debug: {} };
  }

  return { answer: "I couldn't understand that goals command.", debug: {} };
}

// ---------------------------------------------------------------------------
// Activity timer answer builder — used for "what are my timers" / "what's ready"
// ---------------------------------------------------------------------------

interface ActivityTimerEntry {
  entityMid?:   unknown;
  entityLabel?: unknown;
  itemLabel?:   unknown;
  landLabel?:   unknown;
  mapId?:       unknown;
  startedAt?:   unknown;
  readyAt?:     unknown;
}

function buildTimerAnswer(playerId: string | null, extensionTimers: unknown): string | null {
  // Merge: extension timers + DB timers (DB fills in if extension isn't running)
  const dbTimers = playerId ? listActivityTimers(playerId) : [];

  type TimerDisplay = { entityLabel: string; itemLabel: string; landLabel: string; readyAt: number };
  const byMid = new Map<string, TimerDisplay>();

  // Load DB timers first, then let extension timers override (more current)
  for (const t of dbTimers) {
    byMid.set(t.entity_mid, {
      entityLabel: t.entity_label,
      itemLabel:   t.item_label,
      landLabel:   t.land_label,
      readyAt:     t.ready_at,
    });
  }
  if (Array.isArray(extensionTimers)) {
    for (const t of (extensionTimers as ActivityTimerEntry[])) {
      const mid = typeof t.entityMid === "string" ? t.entityMid : null;
      if (!mid) continue;
      byMid.set(mid, {
        entityLabel: typeof t.entityLabel === "string" ? t.entityLabel : "",
        itemLabel:   typeof t.itemLabel   === "string" ? t.itemLabel   : "",
        landLabel:   typeof t.landLabel   === "string" ? t.landLabel   : "",
        readyAt:     typeof t.readyAt     === "number" ? t.readyAt     : 0,
      });
    }
  }

  if (byMid.size === 0) return null;

  const now = Date.now();
  const ready: TimerDisplay[] = [];
  const running: TimerDisplay[] = [];

  for (const t of byMid.values()) {
    if (t.readyAt > 0 && t.readyAt <= now) ready.push(t);
    else running.push(t);
  }

  // Sort running: soonest first
  running.sort((a, b) => a.readyAt - b.readyAt);

  const lines: string[] = [];

  if (ready.length > 0) {
    // Group ready by land
    const byLand = new Map<string, string[]>();
    for (const t of ready) {
      const land = t.landLabel || "unknown land";
      const desc = t.itemLabel ? `${t.itemLabel} (${t.entityLabel})` : t.entityLabel;
      if (!byLand.has(land)) byLand.set(land, []);
      byLand.get(land)!.push(desc);
    }
    lines.push("Ready to collect:");
    for (const [land, descs] of byLand) {
      lines.push(`  On ${land}: ${descs.join(", ")}`);
    }
  }

  if (running.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Still running:");
    for (const t of running) {
      const msLeft = t.readyAt - now;
      const minLeft = Math.round(msLeft / 60_000);
      const timeStr = minLeft >= 60
        ? `${Math.floor(minLeft / 60)}h ${minLeft % 60}m`
        : `${minLeft}m`;
      const desc = t.itemLabel ? `${t.itemLabel} (${t.entityLabel})` : t.entityLabel;
      const where = t.landLabel ? ` on ${t.landLabel}` : "";
      lines.push(`  ${desc}${where} — ready in ${timeStr}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Natural skill-level goal detection
// "i want to level up to 45 in stoneshaping", "get stoneshaping to 45", "level mining to 50"
// ---------------------------------------------------------------------------

function detectNaturalSkillGoal(question: string): { skill: string; targetLevel: number } | null {
  const lq = question.toLowerCase().trim();

  // "level SKILL to N" / "level up SKILL to N"
  let m = lq.match(/\blevel\s+(?:up\s+)?(\w+)\s+to\s+(?:level\s+)?(\d+)\b/);
  if (m) return { skill: m[1], targetLevel: parseInt(m[2], 10) };

  // "get (my) SKILL to (level) N"
  m = lq.match(/\bget\s+(?:my\s+)?(\w+)\s+to\s+(?:level\s+)?(\d+)\b/);
  if (m) return { skill: m[1], targetLevel: parseInt(m[2], 10) };

  // "i want to level up to N in SKILL" / "level up to N in SKILL"
  m = lq.match(/\blevel\s+up\s+to\s+(?:level\s+)?(\d+)\s+in\s+(\w+)\b/);
  if (m) return { skill: m[2], targetLevel: parseInt(m[1], 10) };

  // "want to reach (level) N in SKILL" / "reach (level) N in SKILL"
  m = lq.match(/\b(?:want\s+to\s+)?reach\s+(?:level\s+)?(\d+)\s+(?:in|on)\s+(\w+)\b/);
  if (m) return { skill: m[2], targetLevel: parseInt(m[1], 10) };

  // "want to be level N in SKILL" / "want to get to level N in SKILL"
  m = lq.match(/\bwant\s+to\s+(?:be|get\s+to)\s+(?:level\s+)?(\d+)\s+(?:in|on)\s+(\w+)\b/);
  if (m) return { skill: m[2], targetLevel: parseInt(m[1], 10) };

  return null;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.post("/ask", async (req: Request, res: Response) => {
  // Apply tone filter to every outbound answer.
  const _origJson = res.json.bind(res);
  (res as any).json = (body: any) => {
    if (body && typeof body.answer === "string") {
      body = { ...body, answer: stripPoliteTone(body.answer) };
    }
    return _origJson(body);
  };

  const reqBody = req.body as { question?: unknown; context?: unknown };
  const { question, context: rawContext } = reqBody;

  if (typeof question !== "string" || question.trim() === "") {
    res.status(400).json({ error: 'Request body must include a non-empty "question" string.' });
    return;
  }

  if (
    rawContext !== undefined &&
    (typeof rawContext !== "object" || rawContext === null || Array.isArray(rawContext))
  ) {
    res.status(400).json({ error: '"context" must be a plain object if provided.' });
    return;
  }

  const ctx = rawContext as AskContext | undefined;

  // Fire-and-forget daily diary snapshot/diff.
  const playerId =
    typeof ctx?.player?.playerId === "string" && ctx.player.playerId.trim()
      ? ctx.player.playerId.trim()
      : null;

  // Resolve chest contents: prefer request payload, fall back to persisted DB row.
  const rawChestsFromRequest = (
    ctx?.player?.storageChests && typeof ctx.player.storageChests === "object"
      ? ctx.player.storageChests as Record<string, unknown>
      : null
  );
  let resolvedChests: Record<string, PlayerStorageChest> | null = null;
  if (rawChestsFromRequest && Object.keys(rawChestsFromRequest).length > 0) {
    resolvedChests = rawChestsFromRequest as unknown as Record<string, PlayerStorageChest>;
    const chestCount = Object.keys(resolvedChests).length;
    const perChest = Object.entries(resolvedChests)
      .map(([mid, c]) => `${mid.slice(-4)}:${(c.items ?? []).length}`)
      .join(", ");
    console.log(`[storage] request: ${chestCount} chest${chestCount === 1 ? "" : "s"} (${perChest}), source=${
      Object.values(resolvedChests)[0]?.source ?? "unknown"}`);
    if (playerId) {
      try { upsertPlayerStorage(playerId, resolvedChests); } catch { /* non-fatal */ }
    }
  } else if (playerId) {
    try {
      const persisted = getPlayerStorage(playerId);
      if (Object.keys(persisted).length > 0) {
        resolvedChests = persisted;
        const chestCount = Object.keys(resolvedChests).length;
        console.log(`[storage] fallback: ${chestCount} chest${chestCount === 1 ? "" : "s"} from DB`);
      }
    } catch { /* non-fatal */ }
  }

  // Inject resolved chests back into the player context so all downstream routes
  // pick them up transparently (replaces per-route rawChests reads).
  if (resolvedChests && ctx?.player) {
    (ctx.player as Record<string, unknown>).storageChests = resolvedChests;
  }

  // Single-source taskboard + stacked: resolve once here, enrich ctx so every downstream
  // route (taskboard handlers, buildPrompt / buildStrategyFactsBlock) uses the same data.
  // Use playerId first; fall back to walletAddress so cache survives taskboard closing.
  const _tbCacheKey = playerId
    ?? (typeof ctx?.walletAddress === "string" && ctx.walletAddress.trim() ? ctx.walletAddress.trim().toLowerCase() : null);
  const _resolvedTb  = resolveTaskboard(ctx?.player, _tbCacheKey);
  const _resolvedSt  = resolveStacked(ctx?.player, _tbCacheKey);
  if (ctx?.player) {
    (ctx.player as Record<string, unknown>).taskboard      = _resolvedTb.orders;
    (ctx.player as Record<string, unknown>).stackedOffers  = _resolvedSt.offers;
    (ctx.player as Record<string, unknown>)._tbSource      = _resolvedTb.source;
    (ctx.player as Record<string, unknown>)._stSource      = _resolvedSt.source;
  }
  console.log(`[taskboard] source=${_resolvedTb.source} orders=${_resolvedTb.orders.length} | stacked source=${_resolvedSt.source} offers=${_resolvedSt.offers.length}`);

  if (playerId) {
    try {
      runDailyDiary(
        playerId,
        (ctx?.player?.skills ?? ctx?.player?.levels ?? {}) as Record<string, unknown>,
        (ctx?.player?.coins  ?? ctx?.player?.coinInventory ?? {}) as Record<string, unknown>,
        resolvedChests ?? undefined,
      );
    } catch (err) {
      console.warn("[ask] runDailyDiary failed:", err);
    }
  }

  // Record taskboard item IDs (no player data) for frequency tracking.
  if (Array.isArray(ctx?.player?.taskboard)) {
    for (const order of (ctx!.player!.taskboard as Record<string, unknown>[])) {
      const itemId = typeof order.itemId === "string" ? order.itemId
                   : typeof order.item_id === "string" ? order.item_id : null;
      if (itemId) {
        try { recordTaskboardEvent(itemId); } catch { /* non-fatal */ }
      }
    }
  }

  // Sync activity timers sent by the extension into the DB so they survive reinstall.
  if (playerId && Array.isArray(ctx?.player?.activityTimers)) {
    for (const t of (ctx!.player!.activityTimers as Record<string, unknown>[])) {
      try {
        const mid         = typeof t.entityMid   === "string" ? t.entityMid   : null;
        const entityLabel = typeof t.entityLabel === "string" ? t.entityLabel : "";
        const itemLabel   = typeof t.itemLabel   === "string" ? t.itemLabel   : "";
        const landLabel   = typeof t.landLabel   === "string" ? t.landLabel   : "";
        const mapId       = typeof t.mapId       === "string" ? t.mapId       : "";
        const startedAt   = typeof t.startedAt   === "number" ? t.startedAt   : 0;
        const readyAt     = typeof t.readyAt     === "number" ? t.readyAt     : 0;
        if (mid && readyAt > 0) {
          upsertActivityTimer(playerId, mid, entityLabel, itemLabel, landLabel, mapId, startedAt, readyAt);
        }
      } catch { /* non-fatal */ }
    }
  }

  if (process.env.DEBUG_PROMPTS === "1") {
    console.log("=== RAW REQUEST BODY ===");
    console.log(JSON.stringify(req.body, null, 2));
    console.log("=== END RAW REQUEST BODY ===");
  }

  // Normalize common typos before intent detection ("shoppping" → "shopping")
  const normalizedQuestion = question.trim()
    .replace(/\bshoppp+ing\b/gi, "shopping")
    .replace(/\bshopp+ing\b/gi, "shopping");

  // Strip leading greetings, persona names, and filler so intent detection sees clean input.
  // "hi pixin - where do i get X" → "where do i get X"
  // "hey nyanko, how do I make more coins" → "how do I make more coins"
  const cleanQuestion = (
    normalizedQuestion
      .replace(/^(?:(?:hi|hey|hello|yo|ok|okay|please|thanks)\s*[-,:]?\s*)+/i, "")
      .replace(/^(?:(?:pixin|nyanko|royagi)\s*[-,:]?\s*)+/i, "")
      .trim()
  ) || normalizedQuestion;

  // Shopping list actions: detect intent in code, handle before LLM.
  const shoppingIntent = detectShoppingListIntent(cleanQuestion);
  if (shoppingIntent) {
    const result = await handleShoppingListAction(cleanQuestion, shoppingIntent, playerId);
    if (result) {
      res.json(result);
      return;
    }
    // null = item couldn't be resolved — return explicit not-found; never fall to LLM
    res.json({
      answer: `I couldn't find an item matching "${shoppingIntent.rawText}" in the game catalog. Did you mean something else?`,
      debug: { shoppingListUnresolved: shoppingIntent.rawText },
    });
    return;
  }

  // Natural skill-level goals — "i want to level up to 45 in stoneshaping" etc.
  // Must fire BEFORE goalIntent so it adds goal + shows XP recipes in one reply.
  if (!shoppingIntent) {
    const naturalGoal = detectNaturalSkillGoal(cleanQuestion);
    if (naturalGoal) {
      const canonSkillNat = SKILL_CANON[naturalGoal.skill] ?? null;
      if (canonSkillNat && naturalGoal.targetLevel >= 1 && naturalGoal.targetLevel <= 100) {
        // Save goal (delete existing same-skill goal first)
        if (playerId) {
          const existingGoalsNat = listNotebookGoals(playerId);
          for (const g of existingGoalsNat) {
            if (g.completed) continue;
            const parsed = parseSkillLevelGoal(g.text);
            if (parsed && (SKILL_CANON[parsed.skill] ?? parsed.skill) === canonSkillNat) {
              deleteNotebookGoal(g.id, playerId);
            }
          }
          insertNotebookGoal(playerId, `reach ${canonSkillNat} ${naturalGoal.targetLevel}`);
        }

        const p2nat = ctx?.player;
        const rawSkillsNat = extractSkillsWithExp(p2nat?.skills ?? p2nat?.levels ?? {});
        const skillDataNat = rawSkillsNat[canonSkillNat];
        const playerLevelNat = skillDataNat?.level ?? null;

        const allRecipesNat = queryCatalog({ skill: canonSkillNat, limit: 200 });
        const craftableNat = allRecipesNat
          .filter(r =>
            r.craft_xp !== null && r.craft_xp > 0 &&
            r.craft_energy !== null && r.craft_energy > 0 &&
            !r.is_event_recipe &&
            (r.level_required === null || playerLevelNat === null || r.level_required <= playerLevelNat),
          )
          .map(r => ({ ...r, xpPerEnergy: r.craft_xp! / r.craft_energy! }))
          .sort((a, b) => b.xpPerEnergy - a.xpPerEnergy)
          .slice(0, 8);

        const skillLabelNat = canonSkillNat.charAt(0).toUpperCase() + canonSkillNat.slice(1);
        const levelSuffixNat = playerLevelNat !== null ? ` — you're ${playerLevelNat}` : "";
        const goalSavedMsg = playerId
          ? `Added goal: reach ${skillLabelNat} ${naturalGoal.targetLevel}${levelSuffixNat}.`
          : `Goal (not saved — no player ID): reach ${skillLabelNat} ${naturalGoal.targetLevel}${levelSuffixNat}.`;

        if (craftableNat.length === 0) {
          res.json({ answer: `${goalSavedMsg}\n\nI couldn't find any ${skillLabelNat} recipes in the catalog${playerLevelNat ? ` at your level (${playerLevelNat})` : ""}.`, debug: { naturalGoalPath: true, skill: canonSkillNat } });
          return;
        }

        const xpNeededNat = skillDataNat?.totalExp != null
          ? Math.max(0, skillTotalXpRequired(naturalGoal.targetLevel) - skillDataNat.totalExp)
          : null;

        const xpLinesNat: string[] = [
          goalSavedMsg,
          "",
          `Best ${skillLabelNat} recipes by XP per energy${playerLevelNat ? ` (your level: ${playerLevelNat})` : ""}:`,
        ];
        for (const r of craftableNat) {
          const timeStr = r.craft_time_minutes
            ? `, ${r.craft_time_minutes < 1 ? Math.round(r.craft_time_minutes * 60) + "s" : r.craft_time_minutes + "min"}`
            : "";
          const levelNote = r.level_required ? ` (req. level ${r.level_required})` : "";
          let craftNote = "";
          if (xpNeededNat !== null && r.craft_xp) {
            const craftsNeededNat = Math.ceil(xpNeededNat / r.craft_xp);
            craftNote = ` — ~${craftsNeededNat.toLocaleString()} crafts to reach level ${naturalGoal.targetLevel}`;
          }
          xpLinesNat.push(`- ${r.display_name}: ${r.craft_xp} XP, ${r.craft_energy} energy${timeStr}, ${r.xpPerEnergy.toFixed(1)} XP/energy${levelNote}${craftNote}`);
        }
        const xpNoteNat = xpNeededNat !== null ? ` — ${xpNeededNat.toLocaleString()} XP needed` : "";
        xpLinesNat.push(`\nYour goal: reach ${skillLabelNat} level ${naturalGoal.targetLevel}${xpNoteNat}.`);

        const codeAnswerNat = xpLinesNat.join("\n");
        const personaNat = resolvePersona(ctx?.persona);
        const voiceNat = PERSONA_VOICE[personaNat];
        const finalAnswerNat = await rephraseWithValidation(codeAnswerNat, voiceNat, new Set<string>()).catch(() => codeAnswerNat);
        console.log(`[route] fast:natural-goal skill=${canonSkillNat} level=${naturalGoal.targetLevel}`);
        res.json({ answer: finalAnswerNat, debug: { naturalGoalPath: true, skill: canonSkillNat, targetLevel: naturalGoal.targetLevel } });
        return;
      }
    }
  }

  // Activity timer query — "what are my timers", "what's ready", "show my timers"
  if (!shoppingIntent && /\b(?:my\s+)?timers?\b|\bwhat(?:'s|\s+is|\s+are)\s+ready\b|\bready\s+(?:to\s+collect|to\s+harvest|now)\b/i.test(cleanQuestion)) {
    const timerAnswer = buildTimerAnswer(playerId, ctx?.player?.activityTimers);
    if (timerAnswer) {
      const personaTmr = resolvePersona(ctx?.persona);
      const voiceTmr   = PERSONA_VOICE[personaTmr];
      const finalTmr   = await rephraseWithValidation(timerAnswer, voiceTmr, new Set<string>()).catch(() => timerAnswer);
      console.log(`[route] fast:activity-timers playerId=${playerId}`);
      res.json({ answer: finalTmr, debug: { activityTimerPath: true } });
      return;
    }
  }

  // Goals: detect intent in code, handle before LLM.
  const goalIntent = detectGoalIntent(cleanQuestion);
  if (goalIntent) {
    const skillsWithExp = extractSkillsWithExp(ctx?.player?.skills ?? ctx?.player?.levels ?? {});
    const goalResult = await handleGoalAction(goalIntent, playerId, skillsWithExp);
    res.json(goalResult);
    return;
  }

  // ---------------------------------------------------------------------------
  // Item attribute fast path — "how much energy/XP/time to craft X"
  // Wins over guide routing; never goes to LLM.
  // ---------------------------------------------------------------------------
  {
    const attrQuery = !shoppingIntent && !goalIntent ? detectItemAttrQuery(cleanQuestion) : null;
    if (attrQuery) {
      let attrItemId: string | null = null;
      let attrDisplayName: string | null = null;

      // Try tier+name resolution first, then regular item resolution.
      const tieredId = resolveTieredItemId(attrQuery.itemFragment);
      if (tieredId) {
        attrItemId = tieredId;
      } else {
        try {
          const [fiItemsA, fiAchsA, fiNameMapA] = await Promise.all([
            fetchItems() as Promise<Record<string, any>>,
            fetchAchievements() as Promise<Record<string, any>>,
            fetchLocaleNameMap(),
          ]);
          const attrResolve = resolveItemName(attrQuery.itemFragment, fiNameMapA, fiItemsA, fiAchsA);
          if (attrResolve.kind === "found") attrItemId = attrResolve.itemId;
        } catch { /* fall through */ }
      }

      if (attrItemId) {
        const attrRow = getCatalogRow(attrItemId);
        if (attrRow) {
          attrDisplayName = attrRow.display_name ?? attrItemId;

          type RecipeEntry = {
            station: string | null; skill: string | null; levelRequired: number | null;
            inputs: Array<{ id: string; name: string; qty: number }>;
            outputQty: number; craftTimeMinutes: number | null;
            energy: number | null; craftXp: number | null; isEvent: number;
          };
          const recipes: RecipeEntry[] = attrRow.all_recipes
            ? (() => { try { return JSON.parse(attrRow.all_recipes!); } catch { return []; } })()
            : attrRow.craft_energy !== null || attrRow.craft_xp !== null || attrRow.craft_time_minutes !== null
              ? [{ station: attrRow.recipe_station, skill: attrRow.skill, levelRequired: attrRow.level_required,
                   inputs: [], outputQty: 1, craftTimeMinutes: attrRow.craft_time_minutes,
                   energy: attrRow.craft_energy, craftXp: attrRow.craft_xp, isEvent: 0 }]
              : [];

          const skillLabel = attrRow.skill
            ? attrRow.skill.charAt(0).toUpperCase() + attrRow.skill.slice(1)
            : "Skill";

          const tierSuffix = attrRow.tier ? ` (tier ${attrRow.tier})` : "";
          const lines: string[] = [`${attrDisplayName}${tierSuffix}:`];

          if (recipes.length === 0) {
            lines.push("  No crafting data in catalog.");
          } else {
            for (const r of recipes) {
              const outLabel = r.outputQty > 1 ? `→ ${r.outputQty}× ` : "→ 1× ";
              const parts: string[] = [];
              if (attrQuery.attrs.includes("energy")) {
                parts.push(r.energy !== null ? `${r.energy} energy` : "energy unknown");
              }
              if (attrQuery.attrs.includes("xp")) {
                parts.push(r.craftXp !== null ? `${r.craftXp.toLocaleString()} ${skillLabel} XP` : "XP unknown");
              }
              if (attrQuery.attrs.includes("time")) {
                parts.push(r.craftTimeMinutes !== null ? formatMinutes(r.craftTimeMinutes) : "time unknown");
              }
              lines.push(`  ${outLabel}${attrDisplayName}: ${parts.join(", ")}`);
            }
          }

          const attrAnswer = lines.join("\n");
          if (playerId) {
            lastItemContextMap.set(playerId, { itemId: attrItemId, displayName: attrDisplayName, timestamp: Date.now() });
          }
          console.log(`[route] fast:item-attr item=${attrItemId} attrs=${attrQuery.attrs.join(",")} recipes=${recipes.length}`);
          res.json({ answer: attrAnswer, debug: { itemAttrPath: true, itemId: attrItemId, attrs: attrQuery.attrs } });
          return;
        }
      }
      // If item not found, fall through — the general catalog path or LLM will handle it.
    }
  }

  // ---------------------------------------------------------------------------
  // Guides fast path — returns the ground-truth guide content directly.
  // Never falls through to the LLM: if the guide DB is empty (static/ missing),
  // we return an explicit error rather than letting the model hallucinate.
  // ---------------------------------------------------------------------------
  const guideId = detectGuideId(cleanQuestion);
  if (guideId) {
    const guides = listGuides();
    const guide = guides.find(g => g.id === guideId);
    if (guide) {
      const section = extractGuideSection(guide.content, cleanQuestion);
      let answer = `${guide.title}\n\n${section}`;

      // For tool-tier questions, append the tier info from the catalog.
      if (guideId === "tools") {
        const lqt = cleanQuestion.toLowerCase().replace(/[?!.,;:'"]+/g, " ");
        const toolTypeMatch = lqt.match(/\b(axe|axes|pickaxe|pickaxes|shears?)\b/);
        if (toolTypeMatch) {
          const raw = toolTypeMatch[1];
          const toolNorm = raw.startsWith("axe") ? "axe"
            : raw.startsWith("pickaxe") ? "pickaxe"
            : "shears";
          // ID prefix patterns for tool items (not the tool_type column, which is for crops that need a tool)
          const idPrefixes: Record<string, string[]> = {
            axe:     ["itm_axe_%", "itm_duraAxe_%"],
            pickaxe: ["itm_pickaxe_%", "itm_duraPick_%"],
            shears:  ["itm_shears_%", "itm_duraShears_%"],
          };
          const prefixes = idPrefixes[toolNorm];
          type ToolRow = { item_id: string; display_name: string; tier: number | null; recipe_inputs: string | null; recipe_station: string | null; skill: string | null; level_required: number | null };
          const allToolRows: ToolRow[] = [];
          for (const prefix of prefixes) {
            const rows = db.prepare<unknown[]>(
              `SELECT item_id, display_name, tier, recipe_inputs, recipe_station, skill, level_required
               FROM game_catalog WHERE item_id LIKE ? AND tier IS NOT NULL ORDER BY tier ASC`
            ).all(prefix) as ToolRow[];
            allToolRows.push(...rows);
          }
          // Deduplicate by tier — prefer standard (itm_axe_N) over durable variant when same tier shown
          const seenTiers = new Set<number>();
          const dedupedRows: ToolRow[] = [];
          // Sort: standard items first (no "dura" in id) then durable variants
          allToolRows.sort((a, b) => {
            const aStd = !a.item_id.includes("dura");
            const bStd = !b.item_id.includes("dura");
            if (aStd !== bStd) return aStd ? -1 : 1;
            return (a.tier ?? 0) - (b.tier ?? 0);
          });
          for (const tr of allToolRows) {
            if (tr.tier !== null && !seenTiers.has(tr.tier)) {
              seenTiers.add(tr.tier);
              dedupedRows.push(tr);
            }
          }

          if (dedupedRows.length > 0) {
            // If the question names an explicit tier ("tier 3 axe"), show exactly that tier.
            // Otherwise, if the player's inventory is known, show only the next tier up.
            // Without either, show the full upgrade chain.
            let toolRows = dedupedRows;
            const askedTierMatch = lqt.match(/\btier\s*(\d+)\b/);
            const askedTier = askedTierMatch ? parseInt(askedTierMatch[1], 10) : null;

            if (askedTier !== null) {
              toolRows = dedupedRows.filter(r => r.tier === askedTier);
            } else {
              const inv = ctx?.player?.inventory;
              if (inv && typeof inv === "object" && !Array.isArray(inv)) {
                const invMap = inv as Record<string, unknown>;
                let bestTier = 0;
                for (const tr of allToolRows) {
                  const qty = invMap[tr.item_id];
                  if ((typeof qty === "number" && qty > 0) && (tr.tier ?? 0) > bestTier) {
                    bestTier = tr.tier ?? 0;
                  }
                }
                if (bestTier > 0) {
                  toolRows = dedupedRows.filter(r => r.tier === bestTier + 1);
                }
              }
            }

            const isNextOnly = toolRows.length < dedupedRows.length;
            const recipeLines: string[] = [isNextOnly
              ? `\nNext ${toolNorm} tier (from catalog):`
              : `\n${toolNorm.charAt(0).toUpperCase() + toolNorm.slice(1)} tiers (from catalog):`];
            for (const tr of toolRows) {
              const tierLabel = `Tier ${tr.tier ?? "?"}`;
              if (tr.recipe_inputs) {
                let inputs: { name: string; qty: number }[] = [];
                try { inputs = JSON.parse(tr.recipe_inputs); } catch { continue; }
                const ingredientStr = inputs.map(i => `${i.qty}× ${i.name}`).join(", ");
                const station = tr.recipe_station ? ` at ${tr.recipe_station}` : "";
                const lvl = tr.level_required ? ` (${tr.skill ?? "skill"} level ${tr.level_required})` : "";
                recipeLines.push(`${tierLabel} — ${tr.display_name}: craft with ${ingredientStr}${station}${lvl}`);
              } else {
                const skillLabel = tr.skill ? `${tr.skill.charAt(0).toUpperCase() + tr.skill.slice(1)} level ${tr.level_required ?? "?"}` : `level ${tr.level_required ?? "?"}`;
                recipeLines.push(`${tierLabel} — ${tr.display_name}: not craftable, unlocks at ${skillLabel} (buy from merchant or market)`);
              }
            }
            if (recipeLines.length > 1) answer += recipeLines.join("\n");
          }
        }
      }

      // VIP guide: store static shop prices so "how much do they cost?" returns correct answer.
      // VIP is sold at the VIP Shop (not the marketplace), so prices are fixed in Pixels.
      if (guideId === "vip" && playerId) {
        const VIP_STATIC_PRICES =
          "VIP Shop prices (Pixels):\n" +
          "- 1 Month: 2,600 Pixels\n" +
          "- 3 Months: 6,000 Pixels\n" +
          "- 6 Months: 10,300 Pixels\n" +
          "- 12 Months: 17,200 Pixels\n\n" +
          "Buy at the VIP Shop in Terra Villa (below the fountain) or via Player menu → VIP Benefits → Buy/Extend VIP.";
        lastCandidateListMap.set(playerId, { items: [], staticAnswer: VIP_STATIC_PRICES, timestamp: Date.now() });
      }

      // Reputation guide: personalize with player's trust score and fee rate.
      // Aliases: extension may send trustScore, trust_score, reputation, or reputationScore.
      // String values are parsed since some extensions serialize numbers as strings.
      if (guideId === "reputation" && ctx?.player) {
        const p = ctx.player as Record<string, unknown>;
        const rawTrust = p.trustScore ?? p.trust_score ?? p.reputation ?? p.reputationScore;
        const trust = typeof rawTrust === "number" && Number.isFinite(rawTrust) ? rawTrust
          : typeof rawTrust === "string" ? (isFinite(Number(rawTrust)) ? Number(rawTrust) : null)
          : null;
        const feeRateRaw = numOrNull(p.feeRate as unknown)
          ?? (typeof p.feeRate === "string" && isFinite(Number(p.feeRate)) ? Number(p.feeRate) : null);
        if (trust !== null || feeRateRaw !== null) {
          const lines: string[] = [];
          if (trust !== null) lines.push(`Your reputation (trust score) is ${Math.round(trust).toLocaleString()}.`);
          if (feeRateRaw !== null) lines.push(`Your current marketplace fee rate is ${(feeRateRaw * 100).toFixed(2)}%.`);
          answer = `${lines.join(" ")}\n\n${answer}`;
        }
      }

      // Movement guide: store running shoe as candidate so "how much do they cost?" works
      if (guideId === "movement" && playerId) {
        const SHOE_IDS = ["itm_runningShoe_basic"];
        const shoeCandidates = SHOE_IDS
          .map(id => ({ itemId: id, displayName: getCatalogRow(id)?.display_name ?? "Running Shoes" }));
        lastCandidateListMap.set(playerId, { items: shoeCandidates, timestamp: Date.now() });
      }

      // Return guide content directly — no LLM rephrase to prevent hallucination.
      console.log(`[route] fast:guide id=${guide.id}`);
      res.json({ answer, debug: { guideFastPath: guide.id } });
      return;
    }
    // Guide detected but DB is empty — static/ was not loaded. Block fall-through.
    console.error(`[guides] guideId="${guideId}" detected but not in DB — static data missing`);
    res.json({
      answer: "Guide data isn't loaded yet — the server may still be starting up. Try again in a moment.",
      debug: { guideFastPath: guideId, guideMissing: true },
    });
    return;
  }

  // ---------------------------------------------------------------------------
  // Tips fast path — "any tips?", "boost tips", "how can I play better", etc.
  // ---------------------------------------------------------------------------
  if (isTipsQuery(cleanQuestion)) {
    const codeAnswerTips = pickTips(cleanQuestion, playerId);
    const personaTips = resolvePersona(ctx?.persona);
    const voiceTips   = PERSONA_VOICE[personaTips];
    const finalTips = await rephraseWithValidation(codeAnswerTips, voiceTips).catch(() => codeAnswerTips);
    console.log(`[route] fast:tips`);
    res.json({ answer: finalTips, debug: { tipsFastPath: true } });
    return;
  }

  const keywords = extractKeywords(cleanQuestion);
  const wikiEntries = searchWiki(keywords);

  console.log(
    `[ask] keywords: [${keywords.join(", ")}] → wiki matches: ${
      wikiEntries.length > 0
        ? wikiEntries.map((e) => e.topic).join(", ")
        : "no matches"
    }${ctx ? " (context provided)" : ""}`,
  );

  // ---------------------------------------------------------------------------
  // Stacked offers fast path — lists ALL offers (including ineligible ones).
  // Root cause of "0 Stacked Offers" bug: computeBestActions line `if (!offer.eligible) continue`
  // drops every ineligible offer from immediateWins, so only eligible=true offers appeared.
  // This fast path reads directly from the payload, bypassing that filter.
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && STACKED_OFFERS_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const offers: any[] = Array.isArray(p2?.stackedOffers) ? (p2!.stackedOffers as any[]) : [];

    if (offers.length === 0) {
      const noDataAnswer = "I can't see your Stacked offers right now — open the Stacked app so I can read them.";
      res.json({ answer: noDataAnswer, debug: { stackedFastPath: true, offerCount: 0 } });
      return;
    }

    // Compute sabotage count once for annotation of the sabotage offer.
    const factionIdSt = typeof p2?.factionId === "number" ? (p2!.factionId as number) : null;
    const invSt = p2?.inventory && typeof p2.inventory === "object" && !Array.isArray(p2.inventory)
      ? (p2!.inventory as Record<string, unknown>) : {};
    const rawChestsSt = p2?.storageChests && typeof p2.storageChests === "object"
      ? (p2!.storageChests as Record<string, { items?: Array<{ itemId: string; qty: number }> }>) : null;
    const sabCount = factionIdSt ? computeSabotageCount(factionIdSt, invSt, rawChestsSt).total : null;

    const now = Date.now();
    const lines: string[] = [`You have ${offers.length} Stacked offer${offers.length === 1 ? "" : "s"}:`];
    for (const offer of offers) {
      const req = (typeof offer.requirementText === "string" && offer.requirementText)
        || (typeof offer.description === "string" && offer.description)
        || "Unknown requirement";
      const timer = typeof offer.timerText === "string" ? offer.timerText : "";
      const rewards = Array.isArray(offer.rewards) && offer.rewards.length > 0
        ? offer.rewards.join(", ")
        : "reward unknown";
      const eligibleNote = offer.eligible === true ? " (eligible now)" : "";
      let urgentNote = "";
      const expiresAt = typeof offer.expiresAt === "number" ? offer.expiresAt : null;
      if (expiresAt !== null) {
        const leftMs = expiresAt - now;
        if (leftMs > 0 && leftMs < 3_600_000) {
          urgentNote = ` — EXPIRING SOON (${Math.round(leftMs / 60_000)} min left)`;
        }
      }
      // Annotate sabotage offer with current stock.
      const saboMatch = req.match(/sabotage\s+(?:enemy\s+unions?|unions?)\s+(\d+)\s+times?/i);
      let saboNote = "";
      if (saboMatch && sabCount !== null) {
        const required = parseInt(saboMatch[1], 10);
        saboNote = sabCount >= required
          ? ` — you have ${sabCount} sabotage yieldstones (enough)`
          : ` — you have ${sabCount} of ${required} sabotage yieldstones needed`;
      }
      const timerPart = timer ? `, ${timer} left` : "";
      lines.push(`- ${req}: ${rewards}${timerPart}${eligibleNote}${urgentNote}${saboNote}`);
    }

    const codeAnswer = lines.join("\n");
    const persona2  = resolvePersona(ctx?.persona);
    const voice2    = PERSONA_VOICE[persona2];
    const finalAnswer2 = await rephraseWithValidation(codeAnswer, voice2, new Set<string>()).catch(() => codeAnswer);
    res.json({ answer: finalAnswer2, debug: { stackedFastPath: true, offerCount: offers.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Sabotage count fast path — "how many sabotages do i have"
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && SABOTAGE_COUNT_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const factionId = typeof p2?.factionId === "number" ? (p2.factionId as number) : null;
    const inv2 = p2?.inventory && typeof p2.inventory === "object" && !Array.isArray(p2.inventory)
      ? (p2.inventory as Record<string, unknown>) : null;

    if (!factionId || !inv2) {
      const noDataAns = !factionId
        ? "I don't know which union you're in yet — I'll be able to answer once the game sends your faction data."
        : "I can't see your inventory right now — open the game so I can read it.";
      res.json({ answer: noDataAns, debug: { sabotageCountFastPath: true, noData: true } });
      return;
    }

    const rawChests2 = p2?.storageChests && typeof p2.storageChests === "object"
      ? (p2.storageChests as Record<string, { items?: Array<{ itemId: string; qty: number }> }>) : null;
    const { total, byUnion } = computeSabotageCount(factionId, inv2, rawChests2);
    const unionName = UNION_NAMES[factionId] ?? `faction ${factionId}`;

    const enemyNames = factionId === 1 ? "Flint and Hollow" : factionId === 2 ? "Verdant and Hollow" : "Verdant and Flint";
    let sabAnswer: string;
    if (total === 0) {
      sabAnswer = `You're in ${unionName}, so ${enemyNames} yieldstones are your sabotage items — you have none right now.`;
    } else {
      const breakdown = byUnion.map(b => `${b.stonePrefix} ${b.count}`).join(" · ");
      sabAnswer = `You've got ${total} sabotage stone${total === 1 ? "" : "s"} (${unionName}): ${breakdown}.`;
    }

    console.log(`[route] fast:sabotage-count faction=${factionId} total=${total}`);
    res.json({ answer: sabAnswer, debug: { sabotageCountFastPath: true, factionId, total } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Bountyfall / Hearth Hall season fast path
  // ---------------------------------------------------------------------------
  if (BOUNTYFALL_RE.test(cleanQuestion)) {
    const seasonStart = typeof ctx?.player?.hearthHallSeasonStart === "number"
      ? ctx.player.hearthHallSeasonStart : null;
    let bfAnswer: string;
    if (seasonStart) {
      const d = new Date(seasonStart);
      const dateStr = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
      bfAnswer = `Yes — a Bountyfall season started on ${dateStr}.`;
    } else {
      bfAnswer = "I haven't seen a Bountyfall start message since you installed me. The game announces it in chat and with a pop-up at login.";
    }
    const bfPersona = resolvePersona(ctx?.persona);
    const bfVoice   = PERSONA_VOICE[bfPersona];
    const bfFinal   = await rephraseWithValidation(bfAnswer, bfVoice, new Set<string>()).catch(() => bfAnswer);
    console.log("[route] fast:bountyfall");
    res.json({ answer: bfFinal, debug: { bouncyfallFastPath: true, seasonStart } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Pixel-earning fast path — never mixes with coin strategy.
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && PIXEL_EARNING_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const offers: any[] = Array.isArray(p2?.stackedOffers) ? (p2!.stackedOffers as any[]) : [];
    const buoyBucksBalance = typeof (p2 as any)?.buoyBucks === "number" ? (p2 as any).buoyBucks as number : null;

    const lines: string[] = ["How to earn Pixels:"];

    if (offers.length > 0) {
      lines.push("\nYour current Stacked App offers:");
      const infeasibleNotes: string[] = [];
      for (const offer of offers) {
        const req = (typeof offer.requirementText === "string" && offer.requirementText)
          || (typeof offer.description === "string" && offer.description)
          || "Unknown requirement";
        const timer = typeof offer.timerText === "string" ? offer.timerText : "";
        const rewards = Array.isArray(offer.rewards) && offer.rewards.length > 0
          ? offer.rewards.join(", ")
          : "reward unknown";
        const timerPart = timer ? `, ${timer} remaining` : "";
        const eligibleNote = offer.eligible === true ? " [eligible now]" : "";
        lines.push(`- ${req}: ${rewards}${timerPart}${eligibleNote}`);

        // Infeasibility note: Buoy Bucks spend offer the player can't afford
        if (buoyBucksBalance !== null) {
          const bbSpendMatch = req.match(/spend\s+([\d,]+)\s+buoy\s+bucks?/i);
          if (bbSpendMatch) {
            const required = parseInt(bbSpendMatch[1].replace(/,/g, ""), 10);
            if (buoyBucksBalance < required) {
              infeasibleNotes.push(`Note: "${req}" needs ${required.toLocaleString()} Buoy Bucks — you have ${buoyBucksBalance.toLocaleString()}, not enough right now.`);
            }
          }
        }
      }
      if (infeasibleNotes.length > 0) {
        lines.push("");
        for (const note of infeasibleNotes) lines.push(note);
      }

      // Higher Lower risk note
      const hlOffer = offers.find(o => {
        const t = ((o.requirementText || o.description) as string ?? "").toLowerCase();
        return t.includes("higher lower") || t.includes("higher/lower");
      });
      if (hlOffer) {
        const hlRewards = Array.isArray(hlOffer.rewards) && hlOffer.rewards.length > 0
          ? hlOffer.rewards.join(", ") : "reward unknown";
        lines.push(`\nHigher Lower offer: ${hlRewards} if you hit the target — pure luck, each try costs tokens. Set a limit before you start.`);
      }

      // Overlap detection — tier-aware cross-match + same-skill-in-two-offers.
      // Tier level ranges: T1 0-20, T2 20-40, T3 40-60, T4 60-80, T5 80-100.
      const TIER_LVLS: [number, number][] = [[0,0],[0,20],[20,40],[40,60],[60,80],[80,100]];
      // [matchText, displayName] pairs
      const OVL_SKILLS: [string, string][] = [
        ["stoneshaping","Stoneshaping"],["mining","Mining"],["farming","Farming"],
        ["cooking","Cooking"],["forestry","Forestry"],["metalwork","Metalworking"],
        ["woodwork","Woodworking"],["fishing","Fishing"],["animal care","Animal Care"],
        ["winery","Winery"],
      ];
      // Collect player skill levels
      const rawSkillMap = (p2 as any)?.skills ?? (p2 as any)?.levels ?? {};
      const playerLvls: Record<string,number> = {};
      for (const [k, v] of Object.entries(rawSkillMap as Record<string,unknown>)) {
        const lvl = typeof v === "number" ? v : typeof (v as any)?.level === "number" ? (v as any).level : null;
        if (lvl !== null) playerLvls[k.toLowerCase()] = lvl as number;
      }
      // Parse each offer for tier mentions and named skills
      const tierOffers:  Array<{tier: number}> = [];
      const skillOffers: Array<{key: string; display: string}> = [];
      for (const offer of offers) {
        const t: string = ((offer.requirementText || offer.description) as string ?? "").toLowerCase();
        const tm = t.match(/\btier\s*(\d)\b/i);
        if (tm) tierOffers.push({ tier: parseInt(tm[1]) });
        for (const [key, display] of OVL_SKILLS) {
          if (t.includes(key)) { skillOffers.push({ key, display }); break; }
        }
      }
      const overlapMsgs: string[] = [];
      // Case 1: "Tier N tasks" offer × named-skill offer, player skill level in tier N range
      for (const { tier } of tierOffers) {
        const [minL, maxL] = TIER_LVLS[tier] ?? [0, 100];
        for (const { key, display } of skillOffers) {
          const lvl = playerLvls[key] ?? playerLvls[display.toLowerCase()];
          if (lvl !== undefined && lvl >= minL && lvl < maxL) {
            overlapMsgs.push(`A tier ${tier} ${display} task counts toward both offers.`);
          }
        }
      }
      // Case 2: same skill explicitly named in two or more offers
      for (const [key, display] of OVL_SKILLS) {
        if (overlapMsgs.some(m => m.includes(display))) continue;
        const cnt = offers.filter(o =>
          ((o.requirementText || o.description) as string ?? "").toLowerCase().includes(key)
        ).length;
        if (cnt >= 2) overlapMsgs.push(`Multiple offers involve ${display} — the same task can count toward more than one.`);
      }
      if (overlapMsgs.length > 0) lines.push(`\nOverlap tip: ${overlapMsgs[0]}`);

      // Claim reminder
      lines.push("\nReminder: claim each reward as soon as you hit the target — extras don't carry over.");
    } else {
      lines.push("I can't see your Stacked offers right now — open the Stacked app so I can read them.");
    }

    lines.push("\nOther Pixel sources:");
    lines.push("- Hearth Hall: earn Pixels by ranking on the Hearth Hall leaderboard.");
    lines.push("- Neon Zone: earn Pixels via the Neon Zone leaderboard.");

    const codeAnswer = lines.join("\n");
    const persona2   = resolvePersona(ctx?.persona);
    const voice2     = PERSONA_VOICE[persona2];
    const finalAnswer2 = await rephraseWithValidation(codeAnswer, voice2, new Set<string>()).catch(() => codeAnswer);
    console.log(`[route] fast:pixel-earning`);
    res.json({ answer: finalAnswer2, debug: { pixelEarningFastPath: true, offerCount: offers.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Stacked App general question fast path — "do i have stacked app" etc.
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && STACKED_APP_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const offers: any[] = Array.isArray(p2?.stackedOffers) ? (p2!.stackedOffers as any[]) : [];

    const lines: string[] = [
      "The Stacked App is the main Pixel source in the game — it's how most players earn Pixels.",
      "You complete offers (tasks) to earn Pixel rewards.",
    ];

    if (offers.length > 0) {
      lines.push(`\nYour current Stacked offers (${offers.length} total):`);
      for (const offer of offers) {
        const req = (typeof offer.requirementText === "string" && offer.requirementText)
          || (typeof offer.description === "string" && offer.description)
          || "Unknown requirement";
        const rewards = Array.isArray(offer.rewards) && offer.rewards.length > 0
          ? offer.rewards.join(", ")
          : "reward unknown";
        const timer = typeof offer.timerText === "string" ? offer.timerText : "";
        const timerPart = timer ? `, ${timer} left` : "";
        const eligibleNote = offer.eligible === true ? " (eligible now)" : "";
        lines.push(`- ${req}: ${rewards}${timerPart}${eligibleNote}`);
      }
    } else {
      lines.push("\nOpen the Stacked App in-game to see your current offers and their Pixel rewards.");
    }

    const codeAnswerApp = lines.join("\n");
    const personaApp    = resolvePersona(ctx?.persona);
    const voiceApp      = PERSONA_VOICE[personaApp];
    const finalAnswerApp = await rephraseWithValidation(codeAnswerApp, voiceApp, new Set<string>()).catch(() => codeAnswerApp);
    console.log(`[route] fast:stacked`);
    res.json({ answer: finalAnswerApp, debug: { stackedAppFastPath: true, offerCount: offers.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Taskboard follow-up — "pls list them", "show me", "list them" after a list answer
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && TASKBOARD_FOLLOWUP_RE.test(cleanQuestion)) {
    const prior = playerId ? lastTaskboardAnswerMap.get(playerId) : null;
    if (prior && Date.now() - prior.timestamp < LAST_TASKBOARD_TTL) {
      console.log(`[route] fast:taskboard-followup playerId=${playerId}`);
      res.json({ answer: prior.answer, debug: { taskboardFollowupPath: true } });
      return;
    }
    // No saved answer — fall through to list route below (will save it)
  }

  // ---------------------------------------------------------------------------
  // Taskboard first task — "what task should I complete/do first"
  // Top-1 by net value (reward - fill cost after owned stock). Shows have/need + limit.
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && TASKBOARD_FIRST_RE.test(cleanQuestion)) {
    const p2f = ctx?.player;
    const ordersFirst: any[] = Array.isArray(p2f?.taskboard) ? (p2f!.taskboard as any[]) : [];
    const srcFirst = (p2f as any)?._tbSource ?? "none";
    console.log(`[taskboard] source=${srcFirst} orders=${ordersFirst.length} [first-task route]`);

    if (ordersFirst.length === 0) {
      const noMsg = srcFirst === "none"
        ? "I can't see your taskboard right now — open it so I can read your current orders."
        : "Your taskboard appears empty right now.";
      res.json({ answer: noMsg, debug: { taskboardFirstPath: true, source: srcFirst, orderCount: 0 } });
      return;
    }

    const invF: Record<string, number> = p2f?.inventory && typeof p2f.inventory === "object"
      ? Object.fromEntries(Object.entries(p2f.inventory as Record<string, unknown>).flatMap(([k, v]) => typeof v === "number" ? [[k, v]] : []))
      : {};
    type ChestF = { items: Array<{ itemId: string; qty: number }> };
    const rawChestsF = p2f?.storageChests && typeof p2f.storageChests === "object"
      ? (p2f.storageChests as Record<string, ChestF>) : null;
    const chestF: Record<string, number> = {};
    if (rawChestsF) {
      for (const chest of Object.values(rawChestsF)) {
        if (!Array.isArray(chest.items)) continue;
        for (const sl of chest.items) { if (typeof sl.itemId === "string") chestF[sl.itemId] = (chestF[sl.itemId] ?? 0) + (sl.qty ?? 0); }
      }
    }
    const mpF = p2f?.marketPrices && typeof p2f.marketPrices === "object"
      ? (p2f.marketPrices as Record<string, { lowestPrice: number; quantity: number }>) : {};
    const profF = ctx?.profile && typeof ctx.profile === "object" ? ctx.profile as Record<string, unknown> : {};
    const maxPF = typeof profF.taskboardMaxPrice === "number" ? profF.taskboardMaxPrice : null;

    const parseKF = (s: string): number | null => {
      const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)([Kk]?)$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      return isNaN(n) ? null : m[2] ? Math.round(n * 1000) : Math.round(n);
    };

    const allHeldF: Record<string, number> = { ...invF };
    for (const [k, v] of Object.entries(chestF)) allHeldF[k] = (allHeldF[k] ?? 0) + v;

    type RF = { order: any; netVal: number | null; haveTotal: number; fillCost: number | null; coinReward: number | null; partial?: boolean; marketVolume?: number; craftCost?: number | null; craftEnergy?: number; useCraft?: boolean };
    const ranked: RF[] = [];
    for (const order of ordersFirst) {
      const itemId = resolveTaskboardItemId(order);
      const qty = typeof order.quantityNeeded === "number" ? order.quantityNeeded : 1;
      const costs: string[] = Array.isArray(order.costs) ? (order.costs as string[]) : [];
      const coinReward = costs.length >= 2 ? parseKF(costs[1]) : null;
      const haveTotal = (itemId ? (invF[itemId] ?? 0) : 0) + (itemId ? (chestF[itemId] ?? 0) : 0);
      const stillNeed = Math.max(0, qty - haveTotal);
      const { cost: fillCost, source: priceSourceF, partial: partialF, marketVolume: mvF } = resolveOrderFillCost(itemId, stillNeed, mpF);
      console.log(`[taskboard] first item="${order.itemName}" itemId=${itemId} have=${haveTotal} priceSource=${priceSourceF}`);
      // Buy vs Craft comparison
      let craftCost: number | null = null;
      let craftEnergy = 0;
      let useCraft = false;
      if (itemId && stillNeed > 0) {
        const ce = estimateCraftCost(itemId, stillNeed, allHeldF);
        if (ce !== null && ce.canCraft) {
          craftCost = ce.cost;
          craftEnergy = ce.energy;
          if (fillCost === null || ce.cost < fillCost) useCraft = true;
        }
      }
      const effectiveCost = useCraft ? craftCost : fillCost;
      const netVal = coinReward !== null && effectiveCost !== null ? coinReward - effectiveCost : coinReward ?? null;
      ranked.push({ order, netVal, haveTotal, fillCost: effectiveCost, coinReward, partial: !useCraft ? partialF : undefined, marketVolume: !useCraft ? mvF : undefined, craftCost, craftEnergy, useCraft });
    }
    // Unpriced orders (fillCost unknown) always rank below any priced order
    ranked.sort((a, b) => {
      const av = a.fillCost !== null ? (a.netVal ?? -999_999_998) : -999_999_999;
      const bv = b.fillCost !== null ? (b.netVal ?? -999_999_998) : -999_999_999;
      return bv - av;
    });
    const top = ranked[0];
    const tName = typeof top.order.itemName === "string" ? top.order.itemName : "Unknown item";
    const tQty  = typeof top.order.quantityNeeded === "number" ? top.order.quantityNeeded : 1;
    const haveStr = top.haveTotal >= tQty ? "ready to deliver" : `have ${top.haveTotal}/${tQty}`;
    const playerEnergyF = typeof p2f?.energy === "number" ? p2f.energy
      : numOrNull((p2f?.energy as any)?.level ?? (p2f?.energy as any)?.current);
    let costStr = "";
    if (top.haveTotal >= tQty) {
      costStr = "";
    } else if (top.fillCost !== null && top.fillCost > 0) {
      const method = top.useCraft ? ` (craft, ${top.craftEnergy}⚡)` : " (buy)";
      const tooLowF = top.useCraft && playerEnergyF !== null && (top.craftEnergy ?? 0) > playerEnergyF ? " (more than your energy now)" : "";
      const partNote = top.partial ? ` [market only has ${top.marketVolume?.toLocaleString()} listed]` : "";
      costStr = `, ~${top.fillCost.toLocaleString()} coins${method}${tooLowF}${partNote}`;
    } else if (top.fillCost === 0 && top.useCraft) {
      const engStr = (top.craftEnergy ?? 0) > 0 ? ` · ${top.craftEnergy}⚡` : "";
      const tooLowF = playerEnergyF !== null && (top.craftEnergy ?? 0) > playerEnergyF ? " (more than your energy now)" : "";
      costStr = `, craft from your stock · 0 coins${engStr}${tooLowF}`;
    } else {
      costStr = ", fill cost unknown";
    }
    const payStr   = top.coinReward !== null ? `, pays ${top.coinReward.toLocaleString()} coins` : "";
    const limitStr = maxPF !== null && top.fillCost !== null
      ? (top.fillCost <= maxPF ? " ✓ under your limit" : ` ✗ over your limit (your max: ${maxPF.toLocaleString()})`)
      : "";
    const worthStr = top.netVal !== null && top.netVal > 0 && top.coinReward !== null && top.fillCost !== null ? " 💰 worth doing" : "";
    const firstAnswer = `Do ${tName} ×${tQty} first: ${haveStr}${costStr}${payStr}${limitStr}${worthStr}.`;
    if (playerId) lastTaskboardAnswerMap.set(playerId, { answer: firstAnswer, timestamp: Date.now() });
    console.log(`[route] fast:taskboard-first item=${tName} netVal=${top.netVal} source=${srcFirst}`);
    res.json({ answer: firstAnswer, debug: { taskboardFirstPath: true, orderCount: ordersFirst.length, source: srcFirst } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Taskboard Top-N route — "top seven tasks", "cheapest tasks", "best orders"
  // Ranks orders by net coin value: reward - estimated cost via market prices.
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && TASKBOARD_TOP_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const taskboardTop: any[] = Array.isArray(p2?.taskboard) ? (p2!.taskboard as any[]) : [];
    console.log(`[taskboard] source=${taskboardTop.length > 0 ? "live" : "none"} orders=${taskboardTop.length}`);

    if (taskboardTop.length === 0) {
      res.json({ answer: "I can't see your taskboard right now — open it so I can read your current orders.", debug: { taskboardTopPath: true, orderCount: 0 } });
      return;
    }

    const marketPricesTop = p2?.marketPrices && typeof p2.marketPrices === "object"
      ? (p2.marketPrices as Record<string, { lowestPrice: number; quantity: number }>)
      : {};
    // Owned stock: backpack + all storage chests
    const invTop: Record<string, number> = p2?.inventory && typeof p2.inventory === "object"
      ? Object.fromEntries(Object.entries(p2.inventory as Record<string, unknown>).flatMap(([k, v]) => typeof v === "number" ? [[k, v]] : []))
      : {};
    type ChestTop = { items: Array<{ itemId: string; qty: number }> };
    const rawChestsTop = p2?.storageChests && typeof p2.storageChests === "object"
      ? (p2.storageChests as Record<string, ChestTop>) : null;
    const chestTop: Record<string, number> = {};
    if (rawChestsTop) {
      for (const chest of Object.values(rawChestsTop)) {
        if (!Array.isArray(chest.items)) continue;
        for (const sl of chest.items) { if (typeof sl.itemId === "string") chestTop[sl.itemId] = (chestTop[sl.itemId] ?? 0) + (sl.qty ?? 0); }
      }
    }
    const profTop = ctx?.profile && typeof ctx.profile === "object" ? ctx.profile as Record<string, unknown> : {};
    const maxPTop = typeof profTop.taskboardMaxPrice === "number" ? profTop.taskboardMaxPrice : null;

    const parseKVTop = (s: string): number | null => {
      const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)([Kk]?)$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      return isNaN(n) ? null : m[2] ? Math.round(n * 1000) : Math.round(n);
    };

    // Combined backpack + storage for craft-cost estimation
    const allHeldTop: Record<string, number> = { ...invTop };
    for (const [k, v] of Object.entries(chestTop)) allHeldTop[k] = (allHeldTop[k] ?? 0) + v;

    const playerEnergyTop = typeof p2?.energy === "number" ? p2.energy
      : numOrNull((p2?.energy as any)?.level ?? (p2?.energy as any)?.current);

    // Extract requested N from question ("top 7" → 7, "top seven" → 7, default 5)
    const wordNums: Record<string,number> = { one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10 };
    const topNMatch = cleanQuestion.match(/\b(?:top|best|cheapest)\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
    const requestedN = topNMatch
      ? (parseInt(topNMatch[1]) || wordNums[topNMatch[1].toLowerCase()] || 5)
      : 5;

    const isCheapest = /cheapest/i.test(cleanQuestion);

    type RankedOrder = { label: string; line: string; sortVal: number };
    const ranked: RankedOrder[] = [];

    for (const order of taskboardTop) {
      const itemName = typeof order.itemName === "string" ? order.itemName : "Unknown item";
      const qty = typeof order.quantityNeeded === "number" ? order.quantityNeeded : 1;
      const costs: string[] = Array.isArray(order.costs) ? (order.costs as string[]) : [];
      const coinReward = costs.length >= 2 ? parseKVTop(costs[1]) : null;
      const itemId = resolveTaskboardItemId(order);

      const haveTotal = (itemId ? (invTop[itemId] ?? 0) : 0) + (itemId ? (chestTop[itemId] ?? 0) : 0);
      const stillNeed = Math.max(0, qty - haveTotal);
      const { cost: buyFillCost, source: priceSourceTop, partial: partialTop, marketVolume: mvTop } = resolveOrderFillCost(itemId, stillNeed, marketPricesTop);
      console.log(`[taskboard] top item="${itemName}" itemId=${itemId} have=${haveTotal} priceSource=${priceSourceTop}`);

      // Buy vs Craft comparison
      let craftCostTop: number | null = null;
      let craftEnergyTop = 0;
      let useCraftTop = false;
      if (itemId && stillNeed > 0) {
        const ce = estimateCraftCost(itemId, stillNeed, allHeldTop);
        if (ce !== null && ce.canCraft) {
          craftCostTop = ce.cost;
          craftEnergyTop = ce.energy;
          if (buyFillCost === null || ce.cost < buyFillCost) useCraftTop = true;
        }
      }
      const fillCost = useCraftTop ? craftCostTop : buyFillCost;
      const netVal = coinReward !== null && fillCost !== null ? coinReward - fillCost : coinReward ?? null;

      const catR = itemId ? getCatalogRow(itemId) : null;
      const itemSkill = catR?.skill ?? null;
      const goldenCount = costs.length >= 1 ? parseKVTop(costs[0]) : null;
      let bonusXp = "";
      if (goldenCount !== null && goldenCount > 0) {
        const sl = itemSkill ? itemSkill.charAt(0).toUpperCase() + itemSkill.slice(1) : null;
        bonusXp = sl ? `, +${goldenCount.toLocaleString()} ${sl} XP` : `, +${goldenCount.toLocaleString()} bonus XP`;
      }

      const haveStr  = `have ${haveTotal}/${qty}`;
      let costStr: string;
      if (fillCost !== null && fillCost > 0) {
        const method = useCraftTop ? ` (craft, ${craftEnergyTop}⚡)` : " (buy)";
        const tooLowTop = useCraftTop && playerEnergyTop !== null && craftEnergyTop > playerEnergyTop ? " (more than your energy now)" : "";
        const partNote = !useCraftTop && partialTop ? ` [~${mvTop?.toLocaleString()} listed]` : "";
        costStr = `~${fillCost.toLocaleString()}${method}${tooLowTop}${partNote}`;
      } else if (fillCost === 0 && useCraftTop) {
        const engStr = craftEnergyTop > 0 ? ` · ${craftEnergyTop}⚡` : "";
        const tooLowTop = playerEnergyTop !== null && craftEnergyTop > playerEnergyTop ? " (more than your energy now)" : "";
        costStr = `craft from your stock · 0 coins${engStr}${tooLowTop}`;
      } else if (fillCost === 0) {
        costStr = "ready to deliver";
      } else {
        costStr = "cost unknown";
      }
      const payStr   = coinReward !== null ? `pays ${coinReward.toLocaleString()} coins${bonusXp}` : `item reward${bonusXp}`;
      const limitStr = maxPTop !== null && fillCost !== null
        ? (fillCost <= maxPTop ? " ✓ under your limit" : ` ✗ over your limit (max: ${maxPTop.toLocaleString()})`)
        : "";
      const worthNote = netVal !== null && netVal > 0 && coinReward !== null && fillCost !== null ? " 💰 worth doing" : "";
      const netStr    = netVal !== null && coinReward !== null
        ? (netVal >= 0 ? ` → net +${netVal.toLocaleString()}` : ` → net -${Math.abs(netVal).toLocaleString()} (loss)`)
        : "";

      const line = `${itemName} ×${qty} — ${haveStr} · ${costStr} · ${payStr}${netStr}${limitStr}${worthNote}`;
      // Unpriced orders (fillCost unknown) rank last in all non-cheapest sorts
      const sortVal = isCheapest
        ? (fillCost ?? 999_999_999)
        : (fillCost !== null ? (netVal ?? -999_999_998) : -999_999_999);

      ranked.push({ label: `${itemName} ×${qty}`, line, sortVal });
    }

    ranked.sort((a, b) => isCheapest ? a.sortVal - b.sortVal : b.sortVal - a.sortVal);
    const shown = ranked.slice(0, requestedN);

    const srcTop = (p2 as any)?._tbSource ?? "live";
    const topLabel = isCheapest ? `Cheapest ${shown.length} orders` : `Top ${shown.length} orders by net coin value`;
    const topLines = [`${topLabel} (${taskboardTop.length} total)${srcTop === "cache" ? " [cached]" : ""}:`];
    shown.forEach((r, i) => topLines.push(`${i+1}. ${r.line}`));

    const topAnswer = topLines.join("\n");
    if (playerId) lastTaskboardAnswerMap.set(playerId, { answer: topAnswer, timestamp: Date.now() });
    console.log(`[route] fast:taskboard-top n=${requestedN} isCheapest=${isCheapest} source=${srcTop}`);
    res.json({ answer: topAnswer, debug: { taskboardTopPath: true, orderCount: taskboardTop.length, n: requestedN, source: srcTop } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Taskboard listing — "what's on my taskboard", "show my taskboard", "my orders"
  // Code answer only (no LLM rephrase): each order with rewards + have/need.
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && TASKBOARD_LIST_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const taskboardList: any[] = Array.isArray(p2?.taskboard) ? (p2!.taskboard as any[]) : [];

    console.log(`[taskboard] source=${taskboardList.length > 0 ? "live" : "none"} orders=${taskboardList.length}`);

    if (taskboardList.length === 0) {
      res.json({ answer: "I can't see your taskboard right now — open it so I can read your current orders.", debug: { taskboardListPath: true, orderCount: 0 } });
      return;
    }

    const invList: Record<string, number> = p2?.inventory && typeof p2.inventory === "object"
      ? Object.fromEntries(
          Object.entries(p2.inventory as Record<string, unknown>).flatMap(([k, v]) =>
            typeof v === "number" ? [[k, v]] : [],
          ),
        )
      : {};

    type ChestEntryList = { items: Array<{ itemId: string; qty: number }>; capturedAt?: number };
    const rawChestsList = p2?.storageChests && typeof p2.storageChests === "object"
      ? (p2.storageChests as Record<string, ChestEntryList>) : null;
    const chestContentsList: Record<string, number> = {};
    if (rawChestsList) {
      for (const chest of Object.values(rawChestsList)) {
        if (!Array.isArray(chest.items)) continue;
        for (const slot of chest.items) {
          if (typeof slot.itemId === "string") {
            chestContentsList[slot.itemId] = (chestContentsList[slot.itemId] ?? 0) + (slot.qty ?? 0);
          }
        }
      }
    }
    const chestsOpenedList = rawChestsList !== null;

    const mpList = p2?.marketPrices && typeof p2.marketPrices === "object"
      ? (p2.marketPrices as Record<string, { lowestPrice: number; quantity: number }>) : {};
    const profList = ctx?.profile && typeof ctx.profile === "object" ? ctx.profile as Record<string,unknown> : {};
    const maxPList = typeof profList.taskboardMaxPrice === "number" ? profList.taskboardMaxPrice : null;

    // Combined backpack + storage for craft-cost estimation
    const allHeldList: Record<string, number> = { ...invList };
    for (const [k, v] of Object.entries(chestContentsList)) allHeldList[k] = (allHeldList[k] ?? 0) + v;

    const parseKVList = (s: string): number | null => {
      const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)([Kk]?)$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      return isNaN(n) ? null : m[2] ? Math.round(n * 1000) : Math.round(n);
    };

    const listLines: string[] = [`Your taskboard has ${taskboardList.length} order${taskboardList.length === 1 ? "" : "s"}:`];

    for (const order of taskboardList) {
      const itemName = typeof order.itemName === "string" ? order.itemName : "Unknown item";
      const qty = typeof order.quantityNeeded === "number" ? order.quantityNeeded : 1;
      const costs: string[] = Array.isArray(order.costs) ? (order.costs as string[]) : [];
      const goldenIconCount = costs.length >= 1 ? parseKVList(costs[0]) : null;
      const coinReward = costs.length >= 2 ? parseKVList(costs[1]) : null;
      const itemId = resolveTaskboardItemId(order);
      const catR = itemId ? getCatalogRow(itemId) : null;
      const itemSkillList = catR?.skill ?? null;

      // Reward string
      let rewardStr: string;
      if (coinReward !== null) {
        let bonusXpStr = "";
        if (goldenIconCount !== null && goldenIconCount > 0) {
          const sl = itemSkillList ? itemSkillList.charAt(0).toUpperCase() + itemSkillList.slice(1) : null;
          bonusXpStr = sl ? `, +${goldenIconCount.toLocaleString()} ${sl} XP` : `, +${goldenIconCount.toLocaleString()} bonus XP`;
        }
        rewardStr = `${coinReward.toLocaleString()} coins${bonusXpStr}`;
      } else {
        const rewardItemsArr: string[] = Array.isArray(order.rewardItems) ? (order.rewardItems as string[]) : [];
        rewardStr = rewardItemsArr.length > 0 ? rewardItemsArr.join(", ") : "item reward (open taskboard to see)";
        if (goldenIconCount !== null && goldenIconCount > 0) {
          const sl = itemSkillList ? itemSkillList.charAt(0).toUpperCase() + itemSkillList.slice(1) : null;
          rewardStr += sl ? `, +${goldenIconCount.toLocaleString()} ${sl} XP` : `, +${goldenIconCount.toLocaleString()} bonus XP`;
        }
      }

      // Have/need from backpack + chests
      if (!itemId) {
        console.log(`[taskboard] order "${itemName}" has no itemId — can't check inventory`);
      } else if (!(itemId in invList) && !(itemId in chestContentsList)) {
        console.log(`[taskboard] order "${itemName}" itemId=${itemId} — not found in backpack or storage (have 0)`);
      }
      const backpackCountList = itemId ? (invList[itemId] ?? 0) : 0;
      const chestCountList = itemId && chestsOpenedList ? (chestContentsList[itemId] ?? 0) : 0;
      const totalHaveList = backpackCountList + chestCountList;
      const canDeliverList = totalHaveList >= qty;

      let haveNeedStr: string;
      if (canDeliverList) {
        const haveParts: string[] = [];
        if (backpackCountList > 0) haveParts.push(`${backpackCountList} in backpack`);
        if (chestsOpenedList && chestCountList > 0) haveParts.push(`${chestCountList} in storage`);
        haveNeedStr = `have ${haveParts.join(" + ")} — ready to deliver`;
      } else {
        const stillNeed = qty - totalHaveList;
        if (totalHaveList > 0) {
          const haveParts: string[] = [];
          if (backpackCountList > 0) haveParts.push(`${backpackCountList} in backpack`);
          if (chestsOpenedList && chestCountList > 0) haveParts.push(`${chestCountList} in storage`);
          haveNeedStr = `have ${totalHaveList} (${haveParts.join(" + ")}), need ${stillNeed} more`;
        } else {
          haveNeedStr = `have 0, need ${qty}`;
        }
      }

      // Fill cost + buy-vs-craft + limit
      const stillNeedList = Math.max(0, qty - totalHaveList);
      const { cost: buyFillCostList, source: priceSourceList, partial: partialList, marketVolume: mvList } = resolveOrderFillCost(itemId, stillNeedList, mpList);
      console.log(`[taskboard] list item="${itemName}" itemId=${itemId} have=${totalHaveList} priceSource=${priceSourceList}`);

      let craftCostList: number | null = null;
      let craftEnergyList = 0;
      let useCraftList = false;
      if (itemId && stillNeedList > 0) {
        const ce = estimateCraftCost(itemId, stillNeedList, allHeldList);
        if (ce !== null && ce.canCraft) {
          craftCostList = ce.cost;
          craftEnergyList = ce.energy;
          if (buyFillCostList === null || ce.cost < buyFillCostList) useCraftList = true;
        }
      }
      const fillCostList = useCraftList ? craftCostList : buyFillCostList;

      let costPartList = "";
      if (fillCostList !== null && fillCostList > 0) {
        const method = useCraftList ? ` (craft, ${craftEnergyList}⚡)` : " (buy)";
        const partNote = !useCraftList && partialList ? ` [~${mvList?.toLocaleString()} listed]` : "";
        costPartList = ` · ~${fillCostList.toLocaleString()}${method}${partNote}`;
      }
      const limitPartList = maxPList !== null && fillCostList !== null
        ? (fillCostList <= maxPList ? " ✓ under limit" : ` ✗ over limit (max ${maxPList.toLocaleString()})`)
        : "";
      listLines.push(`${itemName} ×${qty}: ${rewardStr} — ${haveNeedStr}${costPartList}${limitPartList}`);
    }


    const listAnswer = listLines.join("\n");
    if (playerId) lastTaskboardAnswerMap.set(playerId, { answer: listAnswer, timestamp: Date.now() });
    console.log(`[route] fast:taskboard-list orders=${taskboardList.length}`);
    res.json({ answer: listAnswer, debug: { taskboardListPath: true, orderCount: taskboardList.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Taskboard best-item fast path — "which is the best item to craft on my taskboard"
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && TASKBOARD_BEST_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const taskboard: any[] = Array.isArray(p2?.taskboard) ? (p2!.taskboard as any[]) : [];
    console.log(`[taskboard] source=${taskboard.length > 0 ? "live" : "none"} orders=${taskboard.length}`);

    if (taskboard.length === 0) {
      const noTbAnswer = "I can't see your taskboard right now — open it so I can read your current orders.";
      res.json({ answer: noTbAnswer, debug: { taskboardBestPath: true, orderCount: 0 } });
      return;
    }

    const marketPrices = p2?.marketPrices && typeof p2.marketPrices === "object"
      ? (p2.marketPrices as Record<string, { lowestPrice: number; quantity: number }>)
      : {};
    const stackedOffersTb: any[] = Array.isArray(p2?.stackedOffers) ? (p2!.stackedOffers as any[]) : [];
    const hasTaskCompletionOffer = stackedOffersTb.some((o: any) =>
      typeof o.requirementText === "string" && /\btask/i.test(o.requirementText)
    );

    // costs[] format: [goldenIconCount, coinReward] e.g. ["359","14K"]
    // When costs has exactly ONE value, it's the golden icon (bonus skill XP) count — NOT coins.
    const parseKValue = (s: string): number | null => {
      const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)([Kk]?)$/);
      if (!m) return null;
      const n = parseFloat(m[1]);
      return isNaN(n) ? null : m[2] ? Math.round(n * 1000) : Math.round(n);
    };

    const lines: string[] = [`Your taskboard has ${taskboard.length} order${taskboard.length === 1 ? "" : "s"}:`];
    let bestLabel = "";
    let bestNetValue = -1;

    for (const order of taskboard) {
      const itemName = typeof order.itemName === "string" ? order.itemName : "Unknown item";
      const qty = typeof order.quantityNeeded === "number" ? order.quantityNeeded : 1;
      const costs: string[] = Array.isArray(order.costs) ? (order.costs as string[]) : [];

      // costs[0] = golden icon count (bonus skill XP), costs[1] = coin reward
      // A lone value in costs[] is ALWAYS the golden icon XP bonus, never coins.
      const goldenIconCount = costs.length >= 1 ? parseKValue(costs[0]) : null;
      const coinReward      = costs.length >= 2 ? parseKValue(costs[1]) : null;

      const itemId    = typeof order.itemId === "string" ? order.itemId : null;
      const catalogR  = itemId ? getCatalogRow(itemId) : null;
      const itemSkill = catalogR?.skill ?? null;

      // Bonus XP label: "+N Mining XP" using catalog skill; fall back to "+N bonus XP"
      let bonusXpNote = "";
      if (goldenIconCount !== null && goldenIconCount > 0) {
        const skillLabel = itemSkill ? itemSkill.charAt(0).toUpperCase() + itemSkill.slice(1) : null;
        bonusXpNote = skillLabel
          ? `, +${goldenIconCount.toLocaleString()} ${skillLabel} XP (golden icon)`
          : `, +${goldenIconCount.toLocaleString()} bonus XP (golden icon)`;
      }

      const mp        = itemId ? marketPrices[itemId] : null;
      const sellValue = mp ? qty * mp.lowestPrice : null;

      // Cost to obtain = market buy price × qty (proxy for crafting/buying cost)
      const buyCost      = mp ? qty * mp.lowestPrice : null;
      const netDeliver   = coinReward !== null && buyCost !== null ? coinReward - buyCost : coinReward ?? 0;

      // Hint for gathered items: player can get them without buying
      let obtainHint = "";
      if (catalogR?.category === "gathered") {
        const industry = catalogR.industry;
        if (industry === "mine") {
          const tierNote = catalogR.tool_min_tier ? ` (tier ${catalogR.tool_min_tier} pickaxe)` : "";
          obtainHint = ` — or mine them yourself${tierNote}`;
        } else if (industry === "forestry") {
          const tierNote = catalogR.tool_min_tier ? ` (tier ${catalogR.tool_min_tier} axe)` : "";
          obtainHint = ` — or chop them yourself${tierNote}`;
        }
      }

      const stackedNote = hasTaskCompletionOffer ? " (counts toward Stacked offer)" : "";

      // Item reward: use captured rewardItems[0] if available, else generic label
      const rewardItemsArr: string[] = Array.isArray(order.rewardItems) ? (order.rewardItems as string[]) : [];
      const itemRewardLabel = rewardItemsArr.length > 0
        ? rewardItemsArr.join(", ")
        : "item reward (open taskboard to see)";

      const rewardLabel = coinReward !== null
        ? coinReward.toLocaleString() + " coins"
        : itemRewardLabel;

      let line = `${itemName} ×${qty}: DELIVER = ${rewardLabel}${bonusXpNote}${stackedNote}`;
      if (buyCost !== null && coinReward !== null) {
        line += `; buying ~${buyCost.toLocaleString()} coins${obtainHint}`;
        line += ` → net ~${netDeliver.toLocaleString()} coins profit`;
      } else if (coinReward === null && (buyCost !== null || obtainHint)) {
        // Item-reward order: show cost info but no net profit (reward is an item, not coins)
        if (buyCost !== null) line += `; buying ~${buyCost.toLocaleString()} coins${obtainHint}`;
        else if (obtainHint) line += `${obtainHint}`;
      } else if (obtainHint) {
        line += `${obtainHint}`;
      }
      lines.push(`- ${line}`);

      // Rank: coin-reward orders by net profit; item-reward orders listed but ranked below
      const rankValue = coinReward !== null ? netDeliver : -1;
      if (rankValue > bestNetValue) {
        bestNetValue = rankValue;
        bestLabel = `${itemName} ×${qty}`;
      }
    }

    if (bestLabel && bestNetValue > 0) {
      lines.push(`\nBest value: ${bestLabel} (net ~${bestNetValue.toLocaleString()} coins after obtaining)`);
    }
    if (hasTaskCompletionOffer) {
      lines.push("Note: completing any order also counts toward your active Stacked offer — that Pixel reward adds extra value.");
    }

    const codeAnswerTb = lines.join("\n");
    const personaTb   = resolvePersona(ctx?.persona);
    const voiceTb     = PERSONA_VOICE[personaTb];
    const finalAnswerTb = await rephraseWithValidation(codeAnswerTb, voiceTb).catch(() => codeAnswerTb);
    res.json({ answer: finalAnswerTb, debug: { taskboardBestPath: true, orderCount: taskboard.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Taskboard vs inventory fast path — "do I have items for my taskboard orders?"
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && TASKBOARD_HAVE_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const taskboardHave: any[] = Array.isArray(p2?.taskboard) ? (p2!.taskboard as any[]) : [];
    console.log(`[taskboard] source=${taskboardHave.length > 0 ? "live" : "none"} orders=${taskboardHave.length}`);

    if (taskboardHave.length === 0) {
      res.json({ answer: "I can't see your taskboard right now — open it so I can read your current orders.", debug: { taskboardHavePath: true, orderCount: 0 } });
      return;
    }

    const inv: Record<string, number> = p2?.inventory && typeof p2.inventory === "object"
      ? Object.fromEntries(
          Object.entries(p2.inventory as Record<string, unknown>).flatMap(([k, v]) =>
            typeof v === "number" ? [[k, v]] : [],
          ),
        )
      : {};

    // storageChests is Record<string, {items: [{itemId, qty}], capturedAt}> — not an Array.
    type ChestEntryHave = { items: Array<{ itemId: string; qty: number }>; capturedAt: number };
    const rawChestsHave = p2?.storageChests && typeof p2.storageChests === "object"
      ? (p2.storageChests as Record<string, ChestEntryHave>) : null;
    const chestContents: Record<string, number> = {};
    if (rawChestsHave) {
      for (const chest of Object.values(rawChestsHave)) {
        if (!Array.isArray(chest.items)) continue;
        for (const slot of chest.items) {
          if (typeof slot.itemId === "string") {
            chestContents[slot.itemId] = (chestContents[slot.itemId] ?? 0) + (slot.qty ?? 0);
          }
        }
      }
    }
    const chestsOpened = rawChestsHave !== null;

    const haveLines: string[] = [];
    const missingLines: string[] = [];

    for (const order of taskboardHave) {
      const itemName = typeof order.itemName === "string" ? order.itemName : "Unknown item";
      const qty = typeof order.quantityNeeded === "number" ? order.quantityNeeded : 1;
      const itemId = typeof order.itemId === "string" ? order.itemId : null;

      const backpackCount = itemId ? (inv[itemId] ?? 0) : 0;
      const chestCount    = itemId && chestsOpened ? (chestContents[itemId] ?? 0) : 0;
      const totalHave     = backpackCount + chestCount;
      const canDeliver    = totalHave >= qty;

      const haveParts: string[] = [];
      if (backpackCount > 0) haveParts.push(`${backpackCount} in backpack`);
      if (chestsOpened && chestCount > 0) haveParts.push(`${chestCount} in storage`);
      const haveStr = haveParts.length > 0 ? haveParts.join(" + ") : "0";

      if (canDeliver) {
        haveLines.push(`✓ ${itemName} ×${qty}: you have ${haveStr} — ready to deliver`);
      } else {
        const still = qty - totalHave;
        const haveNote = totalHave > 0 ? ` (have ${haveStr})` : "";
        missingLines.push(`✗ ${itemName} ×${qty}: still need ${still}${haveNote}`);
      }
    }

    const resultLines: string[] = [];
    if (haveLines.length > 0) {
      resultLines.push("Ready to deliver:");
      resultLines.push(...haveLines);
    }
    if (missingLines.length > 0) {
      if (resultLines.length > 0) resultLines.push("");
      resultLines.push("Still need:");
      resultLines.push(...missingLines);
    }

    const codeAnswerHave = resultLines.join("\n");
    const personaHave    = resolvePersona(ctx?.persona);
    const voiceHave      = PERSONA_VOICE[personaHave];
    const finalAnswerHave = await rephraseWithValidation(codeAnswerHave, voiceHave).catch(() => codeAnswerHave);
    console.log(`[route] fast:taskboard-have orders=${taskboardHave.length}`);
    res.json({ answer: finalAnswerHave, debug: { taskboardHavePath: true, orderCount: taskboardHave.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Reverse recipe fast path — "what can I make with turkey egg powder"
  // ---------------------------------------------------------------------------
  const reverseIngredient = !shoppingIntent && !goalIntent ? detectReverseRecipeIngredient(cleanQuestion) : null;
  if (reverseIngredient && REVERSE_RECIPE_RE.test(cleanQuestion)) {
    try {
      const matches = findRecipesByIngredient(reverseIngredient);
      if (matches.length > 0) {
        const lines: string[] = [`Recipes that use ${reverseIngredient}:`];
        for (const r of matches) {
          let inputs: Array<{ id: string; name: string; qty: number }> = [];
          try { inputs = JSON.parse(r.recipe_inputs ?? "[]"); } catch { /* ignore */ }
          const ing = inputs.find(i => i.name.toLowerCase().includes(reverseIngredient.toLowerCase()));
          const locked  = r.recipe_unlock_item ? " — needs unlock" : "";
          const detailParts: string[] = [];
          if (ing) detailParts.push(`uses ${ing.qty}`);
          if (r.skill && r.level_required) detailParts.push(`${skillLabel(r.skill)} level ${r.level_required}`);
          else if (r.skill) detailParts.push(skillLabel(r.skill));
          else if (r.level_required) detailParts.push(`level ${r.level_required}`);
          if (r.recipe_station) detailParts.push(r.recipe_station.replace(/\b\w/g, (c: string) => c.toUpperCase()));
          lines.push(`- ${r.display_name} — ${detailParts.join(" · ")}${locked}`);
        }
        const codeAnswerRev = lines.join("\n");
        const personaRev = resolvePersona(ctx?.persona);
        const voiceRev   = PERSONA_VOICE[personaRev];
        const finalAnswerRev = await rephraseWithValidation(codeAnswerRev, voiceRev, new Set<string>()).catch(() => codeAnswerRev);
        console.log(`[route] fast:reverse-recipe ingredient="${reverseIngredient}" matches=${matches.length}`);
        res.json({ answer: finalAnswerRev, debug: { reverseRecipePath: true, ingredient: reverseIngredient, matchCount: matches.length } });
        return;
      }
    } catch (err) {
      console.warn(`[ask] fastpath reverse-recipe error: ${err instanceof Error ? err.message : err}`);
      // fall through to LLM
    }
  }

  // ---------------------------------------------------------------------------
  // Skill XP recipe fast path — "what should I craft to level Stoneshaping"
  // ---------------------------------------------------------------------------
  const skillXpMatch = !shoppingIntent && !goalIntent ? detectSkillXpQuery(cleanQuestion) : null;
  if (skillXpMatch) {
    try {
    const { canonicalSkill } = skillXpMatch;
    const p2 = ctx?.player;
    const rawSkillsXp = extractSkillsWithExp(p2?.skills ?? p2?.levels ?? {});
    const skillData = rawSkillsXp[canonicalSkill];
    const playerLevel = skillData?.level ?? null;

    const allRecipes = queryCatalog({ skill: canonicalSkill, limit: 200 });

    const baseFilter = (r: typeof allRecipes[number]) =>
      r.craft_xp !== null && r.craft_xp > 0 &&
      r.craft_energy !== null && r.craft_energy > 0 &&
      !r.is_event_recipe &&
      (r.level_required === null || playerLevel === null || r.level_required <= playerLevel);

    const craftableRecipes = allRecipes
      .filter(r => baseFilter(r) && r.recipe_unlock_item === null)
      .map(r => ({ ...r, xpPerEnergy: r.craft_xp! / r.craft_energy! }))
      .sort((a, b) => b.xpPerEnergy - a.xpPerEnergy)
      .slice(0, 8);

    const lockedRecipes = allRecipes
      .filter(r => baseFilter(r) && r.recipe_unlock_item !== null)
      .map(r => ({ ...r, xpPerEnergy: r.craft_xp! / r.craft_energy! }))
      .sort((a, b) => b.xpPerEnergy - a.xpPerEnergy)
      .slice(0, 4);

    const skillLabel = SKILL_DISPLAY_NAMES[canonicalSkill] ?? (canonicalSkill.charAt(0).toUpperCase() + canonicalSkill.slice(1));

    if (craftableRecipes.length === 0 && lockedRecipes.length === 0) {
      const noRecipeAns = `I couldn't find any ${skillLabel} recipes with XP in the catalog${playerLevel ? ` at your level (${playerLevel})` : ""}.`;
      res.json({ answer: noRecipeAns, debug: { skillXpPath: true, skill: canonicalSkill } });
      return;
    }

    // Check for an active goal for this skill
    let goalLevel: number | null = null;
    let goalXpNeeded: number | null = null;
    if (playerId) {
      const playerGoals = listNotebookGoals(playerId);
      for (const g of playerGoals) {
        if (g.completed) continue;
        const parsed = parseSkillLevelGoal(g.text);
        if (parsed && parsed.skill === canonicalSkill) {
          goalLevel = parsed.targetLevel;
          if (skillData?.totalExp != null) {
            goalXpNeeded = Math.max(0, skillTotalXpRequired(parsed.targetLevel) - skillData.totalExp);
          }
          break;
        }
      }
    }

    const xpLines: string[] = craftableRecipes.length > 0
      ? [`Best ${skillLabel} recipes by XP per energy${playerLevel ? ` (your level: ${playerLevel})` : ""}:`]
      : [];

    const formatRecipeLine = (r: typeof craftableRecipes[number], goalLevel: number | null, goalXpNeeded: number | null) => {
      const timeStr = r.craft_time_minutes
        ? `, ${r.craft_time_minutes < 1 ? Math.round(r.craft_time_minutes * 60) + "s" : r.craft_time_minutes + "min"}`
        : "";
      const levelNote = r.level_required ? ` (req. level ${r.level_required})` : "";
      let craftNote = "";
      if (goalLevel !== null && goalXpNeeded !== null && r.craft_xp) {
        const craftsNeeded = Math.ceil(goalXpNeeded / r.craft_xp);
        craftNote = ` — ~${craftsNeeded.toLocaleString()} crafts to reach level ${goalLevel}`;
      }
      return `- ${r.display_name}: ${r.craft_xp} XP, ${r.craft_energy} energy${timeStr}, ${r.xpPerEnergy.toFixed(1)} XP/energy${levelNote}${craftNote}`;
    };

    for (const r of craftableRecipes) {
      xpLines.push(formatRecipeLine(r, goalLevel, goalXpNeeded));
    }

    if (lockedRecipes.length > 0) {
      if (xpLines.length > 0) xpLines.push("");
      xpLines.push("Needs a recipe unlock first:");
      for (const r of lockedRecipes) {
        const unlockNote = r.recipe_unlock_source ? ` (unlock: ${r.recipe_unlock_source})` : "";
        xpLines.push(formatRecipeLine(r, goalLevel, goalXpNeeded) + unlockNote);
      }
    }

    if (craftableRecipes.length === 0) {
      xpLines.unshift(`No standard ${skillLabel} recipes found${playerLevel ? ` at your level (${playerLevel})` : ""} — only locked ones:`);
    }

    if (goalLevel !== null) {
      const xpNote = goalXpNeeded !== null ? ` — ${goalXpNeeded.toLocaleString()} XP needed` : "";
      xpLines.push(`\nYour goal: reach ${skillLabel} level ${goalLevel}${xpNote}.`);
    }

    const codeAnswerXp = xpLines.join("\n");
    const personaXp = resolvePersona(ctx?.persona);
    const voiceXp = PERSONA_VOICE[personaXp];
    const finalAnswerXp = await rephraseWithValidation(codeAnswerXp, voiceXp, new Set<string>()).catch(() => codeAnswerXp);
    console.log(`[route] fast:skill-xp skill=${canonicalSkill} recipes=${craftableRecipes.length}`);
    res.json({ answer: finalAnswerXp, debug: { skillXpPath: true, skill: canonicalSkill, recipeCount: craftableRecipes.length } });
    return;
    } catch (err) {
      console.warn(`[ask] fastpath skill-xp error: ${err instanceof Error ? err.message : err}`);
      // fall through to LLM
    }
  }

  // ---------------------------------------------------------------------------
  // Cost-to-make fast path — "how much does it cost to make X" / "how much will that cost"
  // ---------------------------------------------------------------------------
  {
    let costItemId: string | null = null;
    let costItemName: string | null = null;

    if (!shoppingIntent && !goalIntent && COST_TO_MAKE_RE.test(cleanQuestion)) {
      const itemMatchCost = cleanQuestion.match(/\bto\s+(?:make|craft|brew|cook|bake)\s+(.+?)(?:\?|$)/i);
      const rawItemTextCost = itemMatchCost ? itemMatchCost[1].trim() : null;
      if (rawItemTextCost) {
        try {
          const [fiItemsCost, fiAchsCost, fiNameMapCost] = await Promise.all([
            fetchItems() as Promise<Record<string, any>>,
            fetchAchievements() as Promise<Record<string, any>>,
            fetchLocaleNameMap(),
          ]);
          const resolvedCost = resolveItemName(rawItemTextCost, fiNameMapCost, fiItemsCost, fiAchsCost);
          if (resolvedCost.kind === "found") {
            costItemId   = resolvedCost.itemId;
            costItemName = fiNameMapCost[resolvedCost.itemId] ?? rawItemTextCost;
          }
        } catch { /* fall through */ }
      }
    } else if (!shoppingIntent && !goalIntent && COST_FOLLOWUP_RE.test(cleanQuestion)) {
      const lastCtx = playerId ? lastItemContextMap.get(playerId) : null;
      if (lastCtx && Date.now() - lastCtx.timestamp <= LAST_ITEM_TTL) {
        costItemId   = lastCtx.itemId;
        costItemName = lastCtx.displayName;
      }
    }

    if (costItemId && costItemName) {
      const catalogR2 = getCatalogRow(costItemId);
      if (catalogR2 && catalogR2.recipe_inputs) {
        type RecipeInput = { id: string; name: string; qty: number };
        let ingredients: RecipeInput[] = [];
        try { ingredients = JSON.parse(catalogR2.recipe_inputs) as RecipeInput[]; } catch { /* invalid */ }

        if (ingredients.length > 0) {
          const p2c = ctx?.player;
          const invCost: Record<string, number> = p2c?.inventory && typeof p2c.inventory === "object"
            ? Object.fromEntries(
                Object.entries(p2c.inventory as Record<string, unknown>).flatMap(([k, v]) =>
                  typeof v === "number" ? [[k, v]] : [],
                ),
              )
            : {};

          type ChestEntryCost = { items: Array<{ itemId: string; qty: number }>; capturedAt?: number };
          const rawChestsCost = p2c?.storageChests && typeof p2c.storageChests === "object"
            ? (p2c.storageChests as Record<string, ChestEntryCost>) : null;
          const chestContentsCost: Record<string, number> = {};
          if (rawChestsCost) {
            for (const chest of Object.values(rawChestsCost)) {
              if (!Array.isArray(chest.items)) continue;
              for (const slot of chest.items) {
                if (typeof slot.itemId === "string") {
                  chestContentsCost[slot.itemId] = (chestContentsCost[slot.itemId] ?? 0) + (slot.qty ?? 0);
                }
              }
            }
          }

          const costLines: string[] = [`Cost to make 1x ${costItemName}:`];
          let totalCostCoins = 0;
          const missingPriceNames: string[] = [];

          for (const ing of ingredients) {
            const haveBackpackCost = invCost[ing.id] ?? 0;
            const haveChestCost    = rawChestsCost ? (chestContentsCost[ing.id] ?? 0) : 0;
            const haveTotalCost    = haveBackpackCost + haveChestCost;
            const needToBuy        = Math.max(0, ing.qty - haveTotalCost);
            const price            = getMarketPrice(ing.id);

            if (needToBuy > 0 && price) {
              const lineCost = needToBuy * price.min_price;
              totalCostCoins += lineCost;
              const haveNote = haveTotalCost > 0 ? ` (have ${haveTotalCost}, need ${needToBuy} more)` : "";
              costLines.push(`${ing.qty}x ${ing.name} @ ~${price.min_price.toLocaleString()} coins each = ~${lineCost.toLocaleString()} coins${haveNote}`);
            } else if (needToBuy > 0) {
              missingPriceNames.push(ing.name);
              const haveNote = haveTotalCost > 0 ? ` (have ${haveTotalCost}, need ${needToBuy} more)` : "";
              costLines.push(`${ing.qty}x ${ing.name} — price unknown${haveNote}`);
            } else {
              costLines.push(`${ing.qty}x ${ing.name} — you have enough (${haveTotalCost})`);
            }
          }

          if (totalCostCoins > 0) {
            costLines.push(`Total to buy: ~${totalCostCoins.toLocaleString()} coins`);
          } else if (missingPriceNames.length === 0) {
            costLines.push("You have all ingredients — no coins needed to buy.");
          }
          if (catalogR2.craft_energy) {
            costLines.push(`Energy: ${catalogR2.craft_energy}`);
          }

          const resultPriceCost = getMarketPrice(costItemId);
          if (resultPriceCost) {
            costLines.push(`${costItemName} sells for ~${resultPriceCost.min_price.toLocaleString()} coins (lowest market price)`);
            if (totalCostCoins > 0) {
              const profit = resultPriceCost.min_price - totalCostCoins;
              costLines.push(`Estimated profit: ~${profit.toLocaleString()} coins`);
            }
          }
          if (missingPriceNames.length > 0) {
            costLines.push(`Note: no market price on file for: ${missingPriceNames.join(", ")}`);
          }

          if (playerId) {
            lastItemContextMap.set(playerId, { itemId: costItemId, displayName: costItemName, timestamp: Date.now() });
          }
          console.log(`[route] fast:cost-to-make item=${costItemId} total=${totalCostCoins}`);
          res.json({ answer: costLines.join("\n"), debug: { costToMakePath: true, itemId: costItemId, totalCostCoins, missingPrices: missingPriceNames } });
          return;
        }
      }
      // Reached here: item found but no recipe (or COST_FOLLOWUP with no last item that had a recipe)
      if (costItemId && (COST_TO_MAKE_RE.test(cleanQuestion) || COST_FOLLOWUP_RE.test(cleanQuestion))) {
        res.json({ answer: `I don't have a recipe for ${costItemName} in the catalog — it may not be craftable.`, debug: { costToMakePath: true, itemId: costItemId, noRecipe: true } });
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Candidate-list price fast path — "how much do they cost" after a candidates answer
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && CANDIDATE_PRICE_RE.test(cleanQuestion)) {
    const candCtx = playerId ? lastCandidateListMap.get(playerId) : null;
    if (candCtx && Date.now() - candCtx.timestamp <= LAST_CANDIDATE_TTL) {
      // Static answer (e.g. VIP shop prices) takes priority over marketplace lookup.
      if (candCtx.staticAnswer) {
        console.log(`[route] fast:candidate-prices static`);
        res.json({ answer: candCtx.staticAnswer, debug: { candidatePricesPath: true, static: true } });
        return;
      }
      const priceLines: string[] = ["Current market prices:"];
      for (const cand of candCtx.items) {
        const mp = getMarketPrice(cand.itemId);
        if (mp) {
          priceLines.push(`${cand.displayName}: ~${mp.avg_price.toLocaleString()} coins avg (min ${mp.min_price.toLocaleString()}, ${mp.volume} listed)`);
        } else {
          priceLines.push(`${cand.displayName}: no current marketplace listing`);
        }
      }
      if (priceLines.length > 1) {
        const answer = priceLines.join("\n");
        console.log(`[route] fast:candidate-prices items=${candCtx.items.length}`);
        res.json({ answer, debug: { candidatePricesPath: true, items: candCtx.items.length } });
        return;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Item price fast path — "how much does X cost" → market price + craft cost
  // ---------------------------------------------------------------------------
  {
    const priceMatch = ITEM_PRICE_RE.exec(cleanQuestion);
    if (!shoppingIntent && !goalIntent && priceMatch) {
      const rawPriceQuery = priceMatch[1].trim();
      try {
        const [fiNmP, fiItemsP, fiAchsP] = await Promise.all([fetchLocaleNameMap(), fetchItems() as Promise<Record<string,any>>, fetchAchievements() as Promise<Record<string,any>>]);
        const resolvedP = resolveItemName(rawPriceQuery, fiNmP, fiItemsP, fiAchsP);
        if (resolvedP.kind === "found") {
          const pid2 = resolvedP.itemId;
          const dispName = fiNmP[pid2] ?? rawPriceQuery;
          const pLines: string[] = [`Price for ${dispName}:`];

          // Market price
          const mp = getMarketPrice(pid2);
          if (mp) {
            pLines.push(`Market: ~${mp.avg_price.toLocaleString()} coins avg (lowest ${mp.min_price.toLocaleString()}, ${mp.volume} listed)`);
          } else {
            pLines.push(`Market: no current marketplace listing`);
          }

          // Craft cost — use achievements-based recipe lookup (same as recipe route)
          const hm = buildHarvestMap(fiItemsP, fiNmP);
          const invP: Record<string,number> = ctx?.player?.inventory && typeof ctx.player.inventory === "object"
            ? Object.fromEntries(Object.entries(ctx.player.inventory as Record<string,unknown>).flatMap(([k,v]) => typeof v === "number" ? [[k,v]] : []))
            : {};
          const bdP = computeCraftingBreakdown(pid2, 1, fiItemsP, fiAchsP, hm, fiNmP, invP);
          if (bdP.craftable && bdP.directIngredients.length > 0) {
            const ingLines: string[] = [];
            let totalCraftCost = 0;
            let anyMissing = false;
            for (const ing of bdP.directIngredients) {
              const have = invP[ing.id] ?? 0;
              const stillNeed = Math.max(0, ing.totalQty - have);
              const ingMp = getMarketPrice(ing.id);
              if (ingMp) {
                const ingCost = ingMp.min_price * stillNeed;
                totalCraftCost += ingCost;
                const haveStr = have > 0 ? ` (have ${have})` : "";
                ingLines.push(`${ing.name} ×${ing.totalQty}${haveStr} @ ${ingMp.min_price.toLocaleString()} = ${ingCost.toLocaleString()}`);
              } else {
                anyMissing = true;
                const haveStr = have > 0 ? ` (have ${have})` : "";
                ingLines.push(`${ing.name} ×${ing.totalQty}${haveStr} (no market price)`);
              }
            }
            const skillStr = bdP.requiredSkill && bdP.requiredLevel > 0 ? ` — requires ${bdP.requiredSkill} level ${bdP.requiredLevel}` : "";
            pLines.push(`Craft cost (buying missing ingredients)${skillStr}: ${ingLines.join("; ")}${anyMissing ? "" : ` → total ~${totalCraftCost.toLocaleString()} coins`}`);
          } else if (!bdP.craftable) {
            pLines.push(`Craft: not craftable (no recipe in catalog)`);
          }

          if (playerId) lastItemContextMap.set(playerId, { itemId: pid2, displayName: dispName, timestamp: Date.now() });
          console.log(`[route] fast:item-price item=${pid2} query="${rawPriceQuery}"`);
          res.json({ answer: pLines.join("\n"), debug: { itemPricePath: true, itemId: pid2 } });
          return;
        }
      } catch { /* fall through to LLM */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Land ready-finder fast path — "where can I mine gravelglass", "find me a land"
  // ---------------------------------------------------------------------------
  {
    const landPkey = playerId ?? strOrNull(ctx?.walletAddress);
    let landIndustry: string | null = null;
    let landTier:     number | null = null;
    let landLandType: string | null = null;
    let isLandQuery = false;

    // Follow-up: player answered "mine tier 3" after a previous clarification prompt
    if (landPkey) {
      const pending = pendingLandQueryMap.get(landPkey);
      if (pending && Date.now() - pending.timestamp <= PENDING_LAND_QUERY_TTL && LAND_FOLLOWUP_RE.test(cleanQuestion)) {
        pendingLandQueryMap.delete(landPkey);
        const fp = parseLandReadyQuery(cleanQuestion);
        if (fp.industry) {
          landIndustry = fp.industry;
          landTier     = fp.tier;
          landLandType = fp.landType;
          isLandQuery  = true;
        }
      }
    }

    if (!isLandQuery && LAND_READY_RE.test(cleanQuestion)) {
      const lp = parseLandReadyQuery(cleanQuestion);
      landIndustry = lp.industry;
      landTier     = lp.tier;
      landLandType = lp.landType;
      isLandQuery  = true;
    }

    if (isLandQuery) {
      // Item-based catalog lookup: fill in missing tier / industry / landType from item name
      if (landTier === null) {
        const itemFragment = cleanQuestion
          .replace(/\b(?:is\s+there|find(?:ing)?|me|a|an|the|some|any|free|public|open|ready|available|lands?|ponds?|to|for|on|at|where|can|i|there|with|that|is|are|want|do|somewhere)\b/gi, " ")
          .replace(/\b(?:mine|mining|woodwork(?:ing)?|forestry|chop(?:ping)?|farm(?:ming)?|cook(?:ing)?|stoneshaping?|kiln|fish(?:ing)?|metalwork(?:ing)?|animalcare|petcare|catch(?:ing)?|bbq|barb[ae]cue|winery|wine|windmill|textile(?:\s+mill)?|apiary|coop|slug)\b/gi, "")
          .replace(/\btier\s*\d+\b/gi, "")
          .replace(/\b(?:water|soil|grass|space)\s+land\b/gi, "")
          .replace(/\s+/g, " ")
          .trim();

        if (itemFragment.length >= 3) {
          const [fiNameMapL, fiItemsL, fiAchsL] = await Promise.all([
            fetchLocaleNameMap(),
            fetchItems() as Promise<Record<string, any>>,
            fetchAchievements() as Promise<Record<string, any>>,
          ]);
          const resolvedL = resolveItemName(itemFragment, fiNameMapL, fiItemsL, fiAchsL);
          if (resolvedL.kind === "found") {
            const catRow = getCatalogRow(resolvedL.itemId);
            if (catRow) {
              if (!landIndustry && catRow.industry) landIndustry = catRow.industry;
              if (landTier === null && catRow.tier)  landTier    = catRow.tier;
              if (!landLandType && catRow.land_type) {
                const resolved = resolveLandType(catRow.land_type.toLowerCase());
                // Only restrict by land type for truly land-locked items (water/space),
                // not for "land" (soil/grass), which is the generic default land type.
                if (resolved === "water" || resolved === "space") landLandType = resolved;
              }
            }
          }
        }
      }

      if (landIndustry) {
        // Per-player throttle — when throttled, skip re-recording but still serve from cache
        const isThrottled = landPkey ? isPlayerThrottled(landPkey) : false;
        if (landPkey && !isThrottled) recordPlayerSearch(landPkey);

        // Tree spots live in tree_count column; all others use entity strings.
        const isTreeSearch = landIndustry === "tree";
        let countRow: { total: number } | undefined;
        if (isTreeSearch) {
          const tierCond  = landTier !== null
            ? `AND EXISTS (SELECT 1 FROM json_each(tiers_available) WHERE value = 'tier${landTier}')`
            : "";
          const typeCond  = landLandType !== null ? `AND land_type = '${landLandType}'` : "";
          countRow = db
            .prepare(`SELECT COUNT(*) as total FROM land_placements WHERE tree_count IS NOT NULL AND tree_count > 0 ${tierCond} ${typeCond}`)
            .get() as { total: number } | undefined;
        } else {
          const tierCond  = landTier !== null
            ? `AND EXISTS (SELECT 1 FROM json_each(entities) WHERE value GLOB '*_t${landTier}' OR value GLOB '*_${String(landTier).padStart(2, "0")}')`
            : "";
          const typeCond  = landLandType !== null ? `AND land_type = '${landLandType}'` : "";
          countRow = db
            .prepare(`SELECT COUNT(*) as total FROM land_placements WHERE EXISTS (SELECT 1 FROM json_each(entities) WHERE value LIKE ?) ${tierCond} ${typeCond}`)
            .get(`%${landIndustry}%`) as { total: number } | undefined;
        }
        const totalInDB = countRow?.total ?? 0;

        const guildHandle = typeof ctx?.player?.guildHandle === "string" ? ctx!.player!.guildHandle : undefined;
        const lands = await findReadyLands({ industry: landIndustry, tier: landTier ?? undefined, landType: landLandType ?? undefined, guildHandle, limit: 8 })
          .catch(() => []);

        const finalAnswerLand = formatReadyLandsAnswer({
          lands, industry: landIndustry, tier: landTier ?? undefined,
          landType: landLandType ?? undefined, totalInDB,
        });

        console.log(`[route] fast:land-ready industry=${landIndustry} tier=${landTier} landType=${landLandType} found=${lands.length}`);
        res.json({ answer: finalAnswerLand, debug: { landReadyPath: true, industry: landIndustry, tier: landTier, landType: landLandType, totalInDB, landCount: lands.length } });
        return;
      } else {
        // No industry: ask clarification and remember the player asked
        if (landPkey) pendingLandQueryMap.set(landPkey, { timestamp: Date.now() });
        const clarifyMsg = `What would you like to do — mine, chop, farm or fish? (Add the tier too, e.g. "mine tier 3", if you know it.)`;
        res.json({ answer: clarifyMsg, debug: { landReadyPath: true, clarification: true } });
        return;
      }
    }
  }

  // Coin strategy early-return: code computes the answer; LLM only rephrases.
  // Pixel questions are already handled above, so this path is coins-only.
  if (!shoppingIntent && COIN_EARNING_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const rawSkills2 = p2?.skills ?? p2?.levels ?? {};
    const playerSkills2 = Object.fromEntries(
      Object.entries(extractLevels(rawSkills2)).map(([k, v]) => [k.toLowerCase(), v])
    );
    const energy2    = numOrNull(p2?.energy)    ?? 0;
    const energyMax2 = numOrNull(p2?.energyMax) ?? 0;
    const taskboard2 = Array.isArray(p2?.taskboard) ? (p2!.taskboard as unknown[]) : [];

    const playerInv2: Record<string, number> = p2?.inventory && typeof p2.inventory === "object"
      ? Object.fromEntries(
          Object.entries(p2.inventory as Record<string, unknown>).flatMap(([k, v]) =>
            typeof v === "number" ? [[k, v]] : [],
          ),
        )
      : {};

    try {
      const stratResult = computeCoinStrategy({
        playerSkills:     playerSkills2,
        energy:           energy2,
        energyMax:        energyMax2,
        taskboard:        taskboard2,
        playerInventory:  playerInv2,
        chestContents:    p2?.storageChests,
      });

      // Fix 14b: for space/water land items in top results (not already-owned stock), append public lands.
      let coinAnswerWithLands = stratResult.codeAnswer;
      const guildHandleForCoins = strOrNull(ctx?.player?.guildHandle);
      const restrictedOpts = stratResult.topCraftOptions.filter(
        o => !o.isOwnedStock && o.landType && (o.landType.toUpperCase() === "SPACE" || o.landType.toUpperCase() === "WATER")
      );
      for (const opt of restrictedOpts.slice(0, 2)) {
        try {
          const lt = opt.landType!.toLowerCase();
          // Use opt.industry (e.g. "mine" for salt, "farm" for watermint) not a hardcoded guess
          const industry = opt.industry || (lt === "space" ? "mine" : "farm");
          const lands = await findReadyLands({ industry, landType: lt, limit: 3, guildHandle: guildHandleForCoins ?? undefined });
          if (lands.length > 0) {
            const landList = formatReadyLandsAnswer({ lands, industry, landType: lt, totalInDB: 0 });
            coinAnswerWithLands += `\n\n[Public ${lt} lands for ${opt.itemName}]\n${landList}`;
          }
        } catch {
          // land lookup failed — skip
        }
      }

      const persona2     = resolvePersona(ctx?.persona);
      const voice2       = PERSONA_VOICE[persona2];
      const finalAnswer2 = await rephraseWithValidation(coinAnswerWithLands, voice2, stratResult.knownItemNames);

      res.json({
        answer: finalAnswer2,
        debug: {
          coinStrategy:       true,
          codeAnswer:         stratResult.codeAnswer,
          topOptions:         stratResult.topCraftOptions.map(o => o.debug),
          otherOpportunities: stratResult.otherOpportunities.map(o => o.debug),
          missingPrices:      stratResult.missingMarketData,
          ...stratResult.debug,
        },
      });
      return;
    } catch (err) {
      console.warn("[ask] coinStrategy failed, falling through:", err);
    }
  }

  // Crafting quantity query — compute math in code and inject as ground truth.
  let craftingMathSection: string | null = null;
  if (!shoppingIntent) {
    const craftingQuery = detectCraftingQuery(cleanQuestion);
    if (craftingQuery) {
      try {
        const [allItems, allAchievements, nameMap] = await Promise.all([
          fetchItems() as Promise<Record<string, any>>,
          fetchAchievements() as Promise<Record<string, any>>,
          fetchLocaleNameMap(),
        ]);
        const targetResult = resolveItemName(craftingQuery.targetItemText, nameMap, allItems, allAchievements);
        if (targetResult.kind === "found") {
          const inv = ctx?.player?.inventory && typeof ctx.player.inventory === "object"
            ? Object.fromEntries(
                Object.entries(ctx.player.inventory as Record<string, unknown>).flatMap(([k, v]) =>
                  typeof v === "number" ? [[k, v]] : [],
                ),
              )
            : {};
          const harvestMap = buildHarvestMap(allItems, nameMap);
          const bd = computeCraftingBreakdown(
            targetResult.itemId, craftingQuery.quantity,
            allItems, allAchievements, harvestMap, nameMap, inv,
          );
          if (bd.craftable) craftingMathSection = formatCraftingMathSection(bd, inv);
        }
      } catch {
        // Library unavailable — skip math injection, let LLM answer from training
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Inventory fast path — "how many X do i have" / "do i have X"
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent) {
    const invQuery = detectInventoryQuery(cleanQuestion);
    if (invQuery) {
      const p2 = ctx?.player;
      const inv = p2?.inventory && typeof p2.inventory === "object" && !Array.isArray(p2.inventory)
        ? (p2.inventory as Record<string, unknown>)
        : null;

      if (!inv) {
        console.log(`[route] fast:inventory no-data`);
        res.json({ answer: "I can't see your inventory right now — open the game so I can read it.", debug: { inventoryFastPath: true, noData: true } });
        return;
      }

      try {
        const [fiItems2, fiAchs2, fiNameMap2] = await Promise.all([
          fetchItems() as Promise<Record<string, any>>,
          fetchAchievements() as Promise<Record<string, any>>,
          fetchLocaleNameMap(),
        ]);
        const invResolve = resolveItemName(invQuery.itemText, fiNameMap2, fiItems2, fiAchs2);
        // Shared chest helpers for both found + candidates paths.
        type ChestEntry = {
          items: Array<{ itemId: string; qty: number }>;
          landId?: string | null;
          capturedAt: number;
        };
        const rawChests = p2?.storageChests && typeof p2.storageChests === "object"
          ? (p2.storageChests as Record<string, ChestEntry>) : null;
        const hasChestData = rawChests !== null && Object.keys(rawChests).length > 0;

        // Mirrors _stParseMapLabel in content.js — produces friendly location names.
        const locLabelFn = (landId: string | null | undefined): string => {
          if (!landId) return "storage";
          if (landId.startsWith("shareInterior")) {
            const nft = landId.slice("shareInterior".length).match(/^pixelsNFTFarm-?(\d+)/);
            return nft ? `Land ${nft[1]} inside` : "Speck inside";
          }
          if (landId.startsWith("shareRent")) return "Speck outside";
          const nftMatch = landId.match(/^pixelsNFTFarm-?(\d+)/);
          return nftMatch ? `Land ${nftMatch[1]} outside` : "storage";
        };

        // Tally an item across all chests, grouped by location.
        const tallyByLoc = (itemId: string): { total: number; byLoc: Array<{ label: string; count: number }> } => {
          const locMap = new Map<string, number>();
          let total = 0;
          if (rawChests) {
            for (const [, chest] of Object.entries(rawChests)) {
              if (!Array.isArray(chest.items)) continue;
              const label = locLabelFn(chest.landId);
              let locCount = 0;
              for (const slot of chest.items) {
                if (slot.itemId === itemId) locCount += (slot.qty ?? 0);
              }
              if (locCount > 0) { locMap.set(label, (locMap.get(label) ?? 0) + locCount); total += locCount; }
            }
          }
          return { total, byLoc: [...locMap.entries()].map(([label, count]) => ({ label, count })) };
        };

        const buildBreakdown = (backpackCount: number, storageByLoc: Array<{ label: string; count: number }>): string => {
          const parts: string[] = [];
          if (backpackCount > 0) parts.push(`Backpack ${backpackCount}`);
          for (const { label, count } of storageByLoc) parts.push(`${label} ${count}`);
          return parts.length > 0 ? ` — ${parts.join(" \xb7 ")}` : "";
        };

        // Scan nameMap for items whose name contains the query text; returns those the player holds.
        const findAlsoItems = (queryLower: string, excludeId: string): string[] => {
          const also: string[] = [];
          for (const [id, name] of Object.entries(fiNameMap2)) {
            if (id === excludeId) continue;
            if (!name.toLowerCase().includes(queryLower)) continue;
            const bpN = typeof inv[id] === "number" ? (inv[id] as number) : 0;
            const { total: stN, byLoc: locN } = tallyByLoc(id);
            const totN = bpN + stN;
            if (totN > 0) also.push(`${name} ${totN}${buildBreakdown(bpN, locN)}`);
          }
          return also;
        };

        if (invResolve.kind === "found") {
          const backpackCount = typeof inv[invResolve.itemId] === "number" ? (inv[invResolve.itemId] as number) : 0;
          const displayName   = fiNameMap2[invResolve.itemId] ?? invResolve.itemId;
          const assumedNote   = invResolve.fuzzyDisplayName ? ` (assuming you meant ${invResolve.fuzzyDisplayName})` : "";

          const { total: storageCount, byLoc } = tallyByLoc(invResolve.itemId);
          const total = backpackCount + storageCount;
          console.log(`[route] fast:inventory item=${invResolve.itemId} backpack=${backpackCount} storage=${storageCount} total=${total}`);

          const queryLower3 = invQuery.itemText.toLowerCase().trim();
          const isExact = displayName.toLowerCase().trim() === queryLower3;
          // When the resolver returned a partial/substring match (e.g. "Gravelglass Matrix"
          // for query "gravelglass"), use the query word in zero-item answers so the response
          // doesn't claim the user asked about the wrong item.
          const showName = isExact ? displayName : invQuery.itemText;

          let invCodeAnswer: string;
          if (total > 0) {
            const breakdown = buildBreakdown(backpackCount, byLoc);
            invCodeAnswer = invQuery.kind === "count"
              ? `You've got ${total} ${displayName}${breakdown}.${assumedNote}`
              : `Yes — you've got ${total} ${displayName}${breakdown}.${assumedNote}`;
          } else {
            const alsoItems = isExact ? [] : findAlsoItems(queryLower3, invResolve.itemId);
            const noMsg = hasChestData
              ? `No ${showName} in your backpack or storage.`
              : `No ${showName} in your backpack.`;
            invCodeAnswer = alsoItems.length > 0
              ? `${noMsg} Also: ${alsoItems.join("; ")}.${assumedNote}`
              : `${noMsg}${assumedNote}`;
          }
          res.json({ answer: invCodeAnswer, debug: { inventoryFastPath: true, itemId: invResolve.itemId, backpackCount, storageCount, total } });
          return;
        }

        if (invResolve.kind === "candidates") {
          const held: Array<{ displayName: string; total: number; breakdown: string }> = [];
          for (const candidate of invResolve.items) {
            const bpCount = typeof inv[candidate.id] === "number" ? (inv[candidate.id] as number) : 0;
            const { total: stCount, byLoc } = tallyByLoc(candidate.id);
            const tot = bpCount + stCount;
            if (tot > 0) held.push({ displayName: candidate.displayName, total: tot, breakdown: buildBreakdown(bpCount, byLoc) });
          }
          let invCodeAnswer: string;
          if (held.length === 0) {
            invCodeAnswer = hasChestData
              ? `No ${invQuery.itemText} in your backpack or storage.`
              : `No ${invQuery.itemText} in your backpack.`;
          } else {
            const lines = held.map((h) => `${h.total} ${h.displayName}${h.breakdown}`);
            invCodeAnswer = invQuery.kind === "have"
              ? `Yes — ${lines.join("; ")}.`
              : `${lines.join("; ")}.`;
          }
          console.log(`[route] fast:inventory candidates=${invResolve.items.map((c) => c.id).join(",")} held=${held.length}`);
          res.json({ answer: invCodeAnswer, debug: { inventoryFastPath: true, candidates: invResolve.items.map((c) => c.id) } });
          return;
        }

        // not_found: scan name map for any held item whose display name contains the query word
        if (invResolve.kind === "not_found") {
          const queryLower4 = invQuery.itemText.toLowerCase().trim();
          const heldMatches: Array<{ displayName: string; total: number; breakdown: string }> = [];
          for (const [id, name] of Object.entries(fiNameMap2)) {
            if (!name.toLowerCase().includes(queryLower4)) continue;
            const bpN = typeof inv[id] === "number" ? (inv[id] as number) : 0;
            const { total: stN, byLoc: locN } = tallyByLoc(id);
            const tot = bpN + stN;
            if (tot > 0) heldMatches.push({ displayName: name as string, total: tot, breakdown: buildBreakdown(bpN, locN) });
          }
          let invNFAnswer: string;
          if (heldMatches.length === 0) {
            invNFAnswer = hasChestData
              ? `No ${invQuery.itemText} in your backpack or storage.`
              : `No ${invQuery.itemText} in your backpack.`;
          } else if (heldMatches.length === 1) {
            const h = heldMatches[0];
            invNFAnswer = invQuery.kind === "count"
              ? `You've got ${h.total} ${h.displayName}${h.breakdown}.`
              : `Yes — you've got ${h.total} ${h.displayName}${h.breakdown}.`;
          } else {
            const lines = heldMatches.map((h) => `${h.total} ${h.displayName}${h.breakdown}`);
            invNFAnswer = invQuery.kind === "have"
              ? `Yes — ${lines.join("; ")}.`
              : `${lines.join("; ")}.`;
          }
          console.log(`[route] fast:inventory not_found scan query="${invQuery.itemText}" held=${heldMatches.length}`);
          res.json({ answer: invNFAnswer, debug: { inventoryFastPath: true, notFoundScan: true } });
          return;
        }
      } catch {
        // library unavailable — fall through to LLM
      }
    }
  }

  // Fast-path: "what is my overall level" → sum of all skill levels (not the profile "overall" field)
  if (/\b(?:overall|total)\s+(?:skill\s+)?level\b/i.test(cleanQuestion) || /\bwhat(?:'?s|\s+is)\s+my\s+(?:overall|total|combined)\s+(?:skill\s+)?level\b/i.test(cleanQuestion)) {
    const p0 = ctx?.player;
    const rawSkills0 = p0?.skills ?? p0?.levels ?? {};
    const levelsMap0 = extractLevels(rawSkills0);
    const individual0 = Object.entries(levelsMap0).filter(([k]) => !/^(overall|total)$/i.test(k));
    if (individual0.length > 0) {
      const totalSum0 = individual0.reduce((s, [, v]) => s + v, 0);
      res.json({ answer: `Your overall skill level (the sum of all your individual skills) is ${totalSum0}.`, debug: { overallLevelFastPath: true, totalSum: totalSum0 } });
      return;
    }
  }

  // Fast-path: catalog fact question — single item, deterministic template answer
  if (!shoppingIntent && !SKILL_BALANCE_RE.test(cleanQuestion)) {
    const rawLevel0 = ctx?.player?.skills !== undefined || ctx?.player?.levels !== undefined
      ? Object.fromEntries(
          Object.entries((ctx?.player?.skills ?? ctx?.player?.levels ?? {}) as Record<string, unknown>).flatMap(([k, v]) => {
            const lvl = typeof v === "number" ? v : (v && typeof v === "object" ? ((v as Record<string, unknown>).level ?? (v as Record<string, unknown>).current) : null);
            return typeof lvl === "number" ? [[k.toLowerCase(), lvl]] : [];
          })
        )
      : {};
    // Fix 12: look up player's owned land type once for use in crop answers.
    // Check primary wallet AND any additional wallets in cryptoWallets.
    const walletForLand = strOrNull(ctx?.walletAddress);
    const extraWalletsForLand: string[] = [];
    if (ctx?.cryptoWallets && typeof ctx.cryptoWallets === "object" && !Array.isArray(ctx.cryptoWallets)) {
      for (const v of Object.values(ctx.cryptoWallets as Record<string, unknown>)) {
        if (typeof v === "string" && v) extraWalletsForLand.push(v);
      }
    }
    const allWalletsForLand = [walletForLand, ...extraWalletsForLand].filter(Boolean) as string[];
    const playerOwnedLandType = allWalletsForLand.length > 0 ? getPlayerOwnedLandType(allWalletsForLand) : null;
    try {
      const [fiItems, fiAchs, fiNameMap] = await Promise.all([
        fetchItems() as Promise<Record<string, any>>,
        fetchAchievements() as Promise<Record<string, any>>,
        fetchLocaleNameMap(),
      ]);
      // Strip question-wrapper words so "where do i get Clayum Matrix" → "Clayum Matrix"
      // (greetings already stripped by cleanQuestion; only remove the question type prefix here)
      // Also handles run-together typos like "makeblue grumpkin pie" → "blue grumpkin pie"
      const _rawItemQuery = cleanQuestion.replace(/[?]+$/, "").trim();
      const itemQuery = _rawItemQuery
        .replace(/^(?:where\s+(?:do\s+i\s+)?(?:get|find|obtain|buy|mine|harvest|gather)|how\s+(?:do\s+i\s+|can\s+i\s+)?(?:get|obtain|find|mine|harvest|gather|make|craft|create)|where\s+can\s+i\s+(?:get|find|obtain|buy|mine|harvest|make|craft)|how\s+to\s+(?:get|obtain|find|mine|harvest|make|craft))\s+/i, "")
        // Strip planting/growing prefixes so "where can i plant wintermint" → "wintermint"
        .replace(/^(?:where\s+can\s+i\s+(?:plant|grow|farm)|where\s+do\s+i\s+(?:plant|grow|farm)|where\s+should\s+i\s+(?:plant|grow|farm))\s+/i, "")
        // "what's the recipe for X" / "recipe for X" / "ingredients for X" / "what goes into X"
        .replace(/^(?:what(?:'?s|\s+is|\s+are)?\s+(?:the\s+)?)?(?:recipe|ingredients?)\s+(?:for|to\s+(?:make|craft))\s+/i, "")
        .replace(/^what\s+(?:do\s+i\s+need|goes?\s+into|ingredients?\s+(?:do\s+i\s+need\s+(?:to\s+make\s+|for\s+)))\s*/i, "")
        .replace(/^what\s+ingredients?\s+(?:(?:are|is)\s+(?:needed|required)\s+(?:for|to\s+make)\s+)/i, "")
        .replace(/^(?:what\s+is\s+(?:a\s+|an\s+)?|tell\s+me\s+about\s+)/i, "")
        .replace(/^(?:can\s+i\s+(?:farm|mine|chop|gather|harvest|grow|plant|get|obtain|craft|make|cook|brew|build))\s+/i, "")
        // Strip leading articles/quantifiers so "a grassfish" → "grassfish", "some coins" won't hit this
        .replace(/^(?:a|an|the|some|more)\s+/i, "")
        // Handle run-together typos like "makeblue" → "blue"
        .replace(/^make([a-z])/i, "$1")
        .replace(/^how\s+do\s+i\s+make([a-z])/i, "$1")
        // Strip trailing context words that aren't part of the item name
        .replace(/\s+(?:now|today|here|anymore|again)\s*$/i, "")
        .trim();
      // Track whether a prefix strip fired — used to block LLM for unknown items
      const itemStripFired = itemQuery.toLowerCase() !== _rawItemQuery.toLowerCase();
      // Skip item resolution when the query is about a game feature, not an item.
      if (isGameFeatureQuestion(itemQuery || cleanQuestion)) throw new Error("feature_query");

      // Check item aliases for common synonyms that don't match catalog display names.
      const lqAlias = (itemQuery || cleanQuestion).toLowerCase().trim();
      const aliasItemId = ITEM_ALIASES[lqAlias];
      if (aliasItemId) {
        const aliasRow = getCatalogRow(aliasItemId);
        if (aliasRow) {
          const invAlias = ctx?.player?.inventory && typeof ctx.player.inventory === "object"
            ? Object.fromEntries(
                Object.entries(ctx.player.inventory as Record<string, unknown>).flatMap(([k, v]) =>
                  typeof v === "number" ? [[k, v]] : [],
                ),
              )
            : {};
          const fastAnswerAlias = generateFastAnswer(aliasRow, cleanQuestion, rawLevel0, invAlias, playerOwnedLandType);
          if (fastAnswerAlias) {
            const guildHandleStr = strOrNull(ctx?.player?.guildHandle);
            const enrichedAlias = await enrichFastAnswer(fastAnswerAlias, aliasRow, cleanQuestion, guildHandleStr);
            const persona3 = resolvePersona(ctx?.persona);
            const voice3   = PERSONA_VOICE[persona3];
            const rephrasedAlias = await rephraseWithValidation(enrichedAlias, voice3).catch(() => enrichedAlias);
            if (playerId) {
              lastItemContextMap.set(playerId, { itemId: aliasRow.item_id, displayName: aliasRow.display_name ?? aliasRow.item_id, timestamp: Date.now() });
            }
            console.log(`[route] fast:alias item=${aliasRow.item_id}`);
            res.json({ answer: rephrasedAlias, debug: { fastPath: `alias: ${aliasRow.item_id}`, catalogRow: aliasRow } });
            return;
          }
        }
      }

      const fastResolve = resolveItemName(itemQuery || cleanQuestion, fiNameMap, fiItems, fiAchs);
      if (fastResolve.kind === "found") {
        const catalogRow = getCatalogRow(fastResolve.itemId);
        if (catalogRow) {
          const inv = ctx?.player?.inventory && typeof ctx.player.inventory === "object"
            ? Object.fromEntries(
                Object.entries(ctx.player.inventory as Record<string, unknown>).flatMap(([k, v]) =>
                  typeof v === "number" ? [[k, v]] : [],
                ),
              )
            : {};
          const fastAnswer = generateFastAnswer(catalogRow, cleanQuestion, rawLevel0, inv, playerOwnedLandType);
          if (fastAnswer) {
            const guildHandleStr = strOrNull(ctx?.player?.guildHandle);
            const enriched = await enrichFastAnswer(fastAnswer, catalogRow, cleanQuestion, guildHandleStr);
            const assumedNote = fastResolve.fuzzyDisplayName
              ? ` (assuming you meant ${fastResolve.fuzzyDisplayName})`
              : "";
            const fullFastAnswer = enriched + assumedNote;
            const persona3  = resolvePersona(ctx?.persona);
            const voice3    = PERSONA_VOICE[persona3];
            // Don't rephrase yes/no plant answers or recipe answers — LLM mangles both
            const isRecipeAnswer = /\. Needs: \d/.test(fullFastAnswer) || / has \d+ different recipes?:/i.test(fullFastAnswer);
            const rephrasedFast = /^(?:Yes\s*—|No\s*—)/i.test(fullFastAnswer) || isRecipeAnswer
              ? fullFastAnswer
              : await rephraseWithValidation(fullFastAnswer, voice3).catch(() => fullFastAnswer);
            if (playerId) {
              let recipeIngs: Array<{name: string; qty: number}> | undefined;
              if (/\b(?:recipes?|ingredients?|craft|how\s+to\s+(?:make|craft)|how\s+(?:do\s+i|can\s+i)\s+(?:make|craft))\b/i.test(cleanQuestion)) {
                try {
                  if (catalogRow.recipe_inputs) {
                    const parsed = JSON.parse(catalogRow.recipe_inputs) as Array<{id?: string; name?: string; qty?: number}>;
                    recipeIngs = parsed.map(i => ({ name: i.name ?? i.id ?? "", qty: i.qty ?? 1 })).filter(i => i.name);
                  } else if (catalogRow.all_recipes) {
                    const recipes = JSON.parse(catalogRow.all_recipes) as Array<{inputs: Array<{id?: string; name?: string; qty?: number}>}>;
                    if (recipes[0]?.inputs) {
                      recipeIngs = recipes[0].inputs.map(i => ({ name: i.name ?? i.id ?? "", qty: i.qty ?? 1 })).filter(i => i.name);
                    }
                  }
                } catch { /* fall through */ }
              }
              lastItemContextMap.set(playerId, { itemId: catalogRow.item_id, displayName: catalogRow.display_name ?? catalogRow.item_id, ingredients: recipeIngs, timestamp: Date.now() });
            }
            console.log(`[route] fast:catalog item=${catalogRow.item_id}`);
            res.json({
              answer: rephrasedFast,
              debug: { fastPath: `catalog row: ${catalogRow.item_id}`, catalogRow },
            });
            return;
          }
        }
      }

      // Multiple matches — list candidates and ask which one the player means.
      if (fastResolve.kind === "candidates") {
        // Sort: raw gathered/animal/crop items first, crafted dishes/decor last;
        // also penalize inactive items, kits, and blueprints.
        const catRank = (id: string): number => {
          const row = getCatalogRow(id);
          if (!row) return 2;
          if (row.category === "gathered" || row.category === "crop") return 0;
          if (row.category === "crafted") return 2;
          return 1;
        };
        const sortedCandidates = [...fastResolve.items].sort((a, b) => {
          const penaltyA = /\binactive\b|\bkit\b|\bblueprint\b|\bbluepri/i.test(a.displayName) ? 4 : 0;
          const penaltyB = /\binactive\b|\bkit\b|\bblueprint\b|\bbluepri/i.test(b.displayName) ? 4 : 0;
          return (catRank(a.id) + penaltyA) - (catRank(b.id) + penaltyB);
        });
        if (playerId) {
          lastCandidateListMap.set(playerId, {
            items: sortedCandidates.map(c => ({ itemId: c.id, displayName: c.displayName })),
            timestamp: Date.now(),
          });
        }
        const candidateNames = sortedCandidates.map(c => c.displayName).join(", ");
        const persona3 = resolvePersona(ctx?.persona);
        const voice3   = PERSONA_VOICE[persona3];
        const ambigCode = `I found a few items that could match: ${candidateNames}. Which one did you mean?`;
        const ambigFinal = await rephraseWithValidation(ambigCode, voice3).catch(() => ambigCode);
        console.log(`[route] fast:candidates query="${itemQuery}" matches=${fastResolve.items.length}`);
        res.json({ answer: ambigFinal, debug: { candidates: fastResolve.items } });
        return;
      }

      // Item not found — for short queries that look like item names, suggest closest match.
      if (fastResolve.kind === "not_found") {
        const stripped = itemQuery || cleanQuestion;
        // Direct answers for generic ingredient names that map to multiple items
        const directMulti = DIRECT_MULTI_ANSWERS[stripped.toLowerCase()];
        if (directMulti) {
          res.json({ answer: directMulti, debug: { directMultiAnswer: stripped } });
          return;
        }
        // Never trigger fuzzy-match for queries that are actually guide topics
        // (e.g. "baby animals" after stripping "how do i get").
        const isGuideQuery = /\bbaby\s*animals?\b|\bhatching\b|\bincubators?\b|\bbabies\b|\bpotion\s+table\b|\bgathering\s+basket\b|\banimal\s*care\b/.test(stripped.toLowerCase());
        if (
          !isGuideQuery &&
          looksLikeItemQuery(stripped) &&
          stripped.split(/\s+/).length <= 5 &&
          !/^(?:how|where|what|which|when|why|do|can|should|is|are)\s/i.test(stripped)
        ) {
          // For single-word queries, prefer base-material items whose name starts with
          // the query word (e.g. "silk" → "Silk Fiber") over fuzzy-matched kit names.
          let rawPrefixHint: { itemId: string; displayName: string; distance: number } | null = null;
          if (stripped.split(/\s+/).length === 1 && stripped.length >= 3) {
            const sl = stripped.toLowerCase();
            for (const [id, name] of Object.entries(fiNameMap)) {
              if (!name.toLowerCase().startsWith(sl + " ")) continue;
              const cr = getCatalogRow(id);
              if (!cr) continue;
              if (cr.industry === "animal product" || cr.category === "gathered" || cr.industry === "fishing") {
                if (!rawPrefixHint || name.length < rawPrefixHint.displayName.length) {
                  rawPrefixHint = { itemId: id, displayName: name as string, distance: 0 };
                }
              }
            }
          }
          const fuzzyHint = rawPrefixHint ?? fuzzyResolveName(stripped, 1);
          if (fuzzyHint) {
            const persona3 = resolvePersona(ctx?.persona);
            const voice3   = PERSONA_VOICE[persona3];
            const notFoundCode = `I couldn't find an item called "${stripped}". Did you mean ${fuzzyHint.displayName}?`;
            const notFoundFinal = await rephraseWithValidation(notFoundCode, voice3).catch(() => notFoundCode);
            res.json({ answer: notFoundFinal, debug: { notFound: stripped, fuzzyMatch: fuzzyHint.displayName } });
            return;
          }
        }
        // If the question had an item-query prefix stripped but no catalog match was found,
        // refuse to fall through to the LLM — it would invent an answer.
        if (itemStripFired) {
          const persona3 = resolvePersona(ctx?.persona);
          const voice3   = PERSONA_VOICE[persona3];
          const dkCode = `I don't know an item called "${stripped}" — check the spelling?`;
          const dkFinal = await rephraseWithValidation(dkCode, voice3).catch(() => dkCode);
          res.json({ answer: dkFinal, debug: { notFound: stripped, stripFired: true } });
          return;
        }
      }
    } catch {
      // catalog/library unavailable — fall through to LLM
    }
  }

  const { prompt, debug } = await buildPrompt(cleanQuestion, wikiEntries, ctx, craftingMathSection);

  const approxTokens = Math.ceil(prompt.length / 4);
  console.log(`[route] llm prompt≈${approxTokens}tok`);

  if (process.env.DEBUG_PROMPTS === "1") {
    console.log("=== PLAYER CONTEXT SECTION (isolated) ===");
    console.log(formatContext(ctx) ?? "(empty — no player context resolved)");
    console.log("=== END PLAYER CONTEXT SECTION ===");
    console.log("=== FULL PROMPT SENT TO OLLAMA ===");
    console.log(prompt);
    console.log("=== END FULL PROMPT SENT TO OLLAMA ===");
  }

  const isStrategyLlm = SKILL_BALANCE_RE.test(cleanQuestion) &&
    Object.keys(extractLevels(ctx?.player?.skills ?? ctx?.player?.levels ?? {})).length >= 3;
  try {
    const llmResult = await askLLM(prompt, { numPredict: isStrategyLlm ? 520 : 300 });
    console.log(`[ask] model=${llmResult.model} time=${llmResult.durationMs}ms`);
    const rawAnswer = stripThinkBlocks(llmResult.text);
    if (!rawAnswer) {
      console.warn(`[ask] not-sure: LLM returned empty text after stripThinkBlocks (model=${llmResult.model})`);
    }
    const answer = stripMarkdown(validateAnswer(rawAnswer));
    if (!answer) {
      console.warn(`[ask] not-sure: validateAnswer stripped everything (raw="${rawAnswer.slice(0, 100)}")`);
    }
    if (inventedItemsInAnswer(answer)) {
      console.warn(`[ask] not-sure: inventedItemsInAnswer triggered (answer="${answer.slice(0, 150)}")`);
      res.json({
        answer: "I'm not sure about that one — try asking about a specific item or crafting recipe.",
        debug: { ...debug, inventedItemsRejected: true },
      });
      return;
    }
    res.json({ answer, debug });
  } catch (err) {
    if (err instanceof LLMUnavailableError) {
      // Build a code-written fallback using the full player facts so the player
      // still gets actionable info when the LLM is down.
      const p2 = ctx?.player;
      const fallbackLines: string[] = [];
      const now = Date.now();

      // Stacked offers — all, soonest expiry first
      const allOffers: any[] = Array.isArray(p2?.stackedOffers) ? (p2!.stackedOffers as any[]) : [];
      if (allOffers.length > 0) {
        const sortedOffers = [...allOffers].sort((a: any, b: any) => {
          const ae = typeof a.expiresAt === "number" ? a.expiresAt : Infinity;
          const be = typeof b.expiresAt === "number" ? b.expiresAt : Infinity;
          return ae - be;
        });
        fallbackLines.push("Your Stacked offers (soonest ending first):");
        for (const offer of sortedOffers) {
          const req = (typeof offer.requirementText === "string" && offer.requirementText)
            || (typeof offer.description === "string" && offer.description)
            || "Unknown";
          const rew = Array.isArray(offer.rewards) && offer.rewards.length > 0
            ? offer.rewards.join(", ") : "reward unknown";
          const cur = typeof offer.progressCurrent === "number" ? offer.progressCurrent : null;
          const tot = typeof offer.progressRequired === "number" ? offer.progressRequired : null;
          const progPart = cur !== null && tot !== null ? ` (${cur}/${tot})` : "";
          const exp = typeof offer.expiresAt === "number" ? offer.expiresAt : null;
          let timePart = "";
          if (exp !== null) {
            const leftMs = exp - now;
            if (leftMs > 0) {
              const h = Math.floor(leftMs / 3_600_000);
              const m = Math.floor((leftMs % 3_600_000) / 60_000);
              timePart = ` — ${h > 0 ? `${h}h ` : ""}${m}m left`;
            } else {
              timePart = " — EXPIRED";
            }
          }
          fallbackLines.push(`- ${req}: ${rew}${progPart}${timePart}`);
        }

        // Overlap tip: find any two offers sharing a skill keyword
        const SKILL_WORDS_FB = ["stoneshaping", "mining", "farming", "cooking", "forestry",
          "metalworking", "woodworking", "fishing", "petcare", "exploration", "business"];
        const offerSkills = sortedOffers.map((o: any) => {
          const t = ((o.requirementText || o.description) as string ?? "").toLowerCase();
          return SKILL_WORDS_FB.filter(s => t.includes(s));
        });
        for (let i = 0; i < offerSkills.length; i++) {
          for (let j = i + 1; j < offerSkills.length; j++) {
            const shared = offerSkills[i].find((s: string) => offerSkills[j].includes(s));
            if (shared) {
              const oA = sortedOffers[i];
              const oB = sortedOffers[j];
              const nameA = (oA.requirementText || oA.description || "offer") as string;
              const nameB = (oB.requirementText || oB.description || "offer") as string;
              fallbackLines.push(`Tip: ${skillLabel(shared)} actions count toward both "${nameA}" and "${nameB}" at once.`);
              break;
            }
          }
          if (fallbackLines.some(l => l.startsWith("Tip:"))) break;
        }
      }

      // Taskboard orders — show all, flag cheap ones vs max price
      const taskboardFb: any[] = Array.isArray(p2?.taskboard) ? (p2!.taskboard as any[]) : [];
      if (taskboardFb.length > 0) {
        const maxPrice = typeof (p2 as any)?.maxTaskboardPrice === "number"
          ? (p2 as any).maxTaskboardPrice as number : null;
        fallbackLines.push("\nTaskboard orders:");
        for (const order of taskboardFb) {
          const name = typeof order.itemName === "string" ? order.itemName
            : typeof order.label === "string" ? order.label
            : typeof order.name === "string" ? order.name : "item";
          const qty = typeof order.quantity === "number" ? ` ×${order.quantity}` : "";
          const coinReward = typeof order.reward === "number" ? order.reward
            : typeof order.coinReward === "number" ? order.coinReward : null;
          const rewardStr = coinReward !== null ? ` — ${coinReward.toLocaleString()} Coins` : "";
          // Flag if within budget
          let budgetNote = "";
          if (maxPrice !== null && coinReward !== null) {
            budgetNote = coinReward <= maxPrice ? " (within your budget)" : " (above your budget)";
          }
          fallbackLines.push(`- ${name}${qty}${rewardStr}${budgetNote}`);
        }
      }

      // Lowest skill
      const fbLevelMap = extractLevels(p2?.skills ?? p2?.levels ?? {});
      const skillEntries = Object.entries(fbLevelMap)
        .filter(([k]) => !/^(overall|total)$/i.test(k))
        .sort((a, b) => a[1] - b[1]);
      if (skillEntries.length > 0) {
        const [lowestKey, lowestLvl] = skillEntries[0];
        fallbackLines.push(`\nLowest skill to focus on: ${skillLabel(lowestKey)} (level ${lowestLvl})`);
      }

      fallbackLines.push("\n(My big brain is offline right now — try again shortly for a personalized answer.)");

      console.warn("[ask] LLM offline — returning code-written fallback");
      res.json({ answer: fallbackLines.join("\n"), debug: { llmOffline: true } });
      return;
    }
    console.error("[ask] unhandled error:", err);
    const persona = resolvePersona(ctx?.persona);
    const fallbacks = PERSONA_FALLBACKS[persona];
    res.json({ answer: fallbacks[Math.floor(Math.random() * fallbacks.length)], debug: { internalError: String(err) } });
  }
});

// ---------------------------------------------------------------------------
// GET /api/debug/llm-health — tests each provider and reports ok/fail + latency
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
// ---------------------------------------------------------------------------

router.get("/api/debug/llm-health", async (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  const probe = "Reply with the word ok";
  type HealthResult = { ok: boolean; model?: string; reply?: string; latencyMs?: number; error?: string; models?: string[] };
  const results: Record<string, HealthResult> = {};

  const { resolveGroqModel, resolveGeminiFlashModel, getGroqChatModels } = await import("../services/llm");

  // Groq
  {
    const t0 = Date.now();
    try {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error("GROQ_API_KEY not set");

      // resolveGroqModel handles exclusion filtering and caching
      const model = await resolveGroqModel(apiKey);
      if (!model) throw new Error("no suitable chat model found in Groq model list");

      const chatUrl = "https://api.groq.com/openai/v1/chat/completions";
      const resp = await fetch(chatUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: probe }], max_tokens: 10, temperature: 0 }),
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status === 429) throw new Error("rate limit (429)");
      if (!resp.ok) {
        const snippet = (await resp.text().catch(() => "")).slice(0, 300);
        throw new Error(`HTTP ${resp.status} body=${snippet}`);
      }
      const body = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
      const reply = (body?.choices?.[0]?.message?.content ?? "").trim();
      if (!reply) throw new Error("empty reply from model");
      results.groq = { ok: true, model: `groq/${model}`, reply, latencyMs: Date.now() - t0, models: getGroqChatModels() };
      console.log(`[llm-health] groq ok ${Date.now() - t0}ms model=${model} reply="${reply}"`);
    } catch (err) {
      results.groq = { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - t0 };
    }
  }

  // Gemini — resolveGeminiFlashModel tests candidates internally; use its verified model
  {
    const t0 = Date.now();
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY not set");

      // This runs test calls internally and returns the first working model
      const model = await resolveGeminiFlashModel(apiKey);

      const gemUrl = `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`;
      const resp = await fetch(gemUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: probe }] }], generationConfig: { maxOutputTokens: 10, temperature: 0 } }),
        signal: AbortSignal.timeout(15_000),
      });
      if (resp.status === 429) throw new Error("rate limit (429)");
      if (!resp.ok) {
        const snippet = (await resp.text().catch(() => "")).slice(0, 300);
        throw new Error(`HTTP ${resp.status} body=${snippet}`);
      }
      const body = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const reply = (body?.candidates?.[0]?.content?.parts?.[0]?.text ?? "").trim();
      if (!reply) throw new Error("empty reply from model");
      results.gemini = { ok: true, model: `gemini/${model}`, reply, latencyMs: Date.now() - t0 };
      console.log(`[llm-health] gemini ok ${Date.now() - t0}ms model=${model} reply="${reply}"`);
    } catch (err) {
      results.gemini = { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - t0 };
    }
  }

  // Local (Ollama)
  {
    const t0 = Date.now();
    try {
      const { askOllama: _askOllama } = await import("../services/ollama");
      const reply = (await _askOllama(probe, { numPredict: 10 })).trim();
      if (!reply) throw new Error("empty reply from local model");
      const model = process.env.OLLAMA_MODEL ?? "qwen2.5:3b";
      results.local = { ok: true, model: `local/${model}`, reply, latencyMs: Date.now() - t0 };
      console.log(`[llm-health] local ok ${Date.now() - t0}ms reply="${reply}"`);
    } catch (err) {
      results.local = { ok: false, error: err instanceof Error ? err.message : String(err), latencyMs: Date.now() - t0 };
    }
  }

  const chain = (process.env.LLM_PROVIDER ?? "auto").toLowerCase().trim();
  res.json({ chain, results, checkedAt: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// GET /api/debug/prompt-config  — full prompt config dump for inspection
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
// ---------------------------------------------------------------------------

router.get("/api/debug/prompt-config", (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  const wikiEntries = db
    .prepare<[], { id: number; topic: string; content: string }>(
      "SELECT id, topic, content FROM wiki_entries ORDER BY id"
    )
    .all();

  const standingInstructions: Record<string, string> = {};
  for (const persona of ["pixin", "goat", "cat"] as const) {
    standingInstructions[persona] = buildStandingInstructions(PERSONA_VOICE[persona]);
  }

  res.json({
    wikiEntries,
    personaIntros: PERSONA_INTROS,
    personaVoice: PERSONA_VOICE,
    standingInstructions,
    bannedPatterns: BANNED_PATTERNS.map(({ id, pattern }) => ({ id, pattern: typeof pattern === "function" ? `[function] ${pattern.toString().slice(0, 300)}` : pattern.toString() })),
    recentViolations: recentViolations.slice(0, 20),
  });
});

// ---------------------------------------------------------------------------
// GET /debug/resource-access — test computeResourceAccess against live library
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
//
// Query params:
//   item=<itemId or item name>  — required
//   mining=<level>              — optional skill level
//   forestry=<level>
//   farming=<level>
//   tools=itm_pickaxe_03,...    — comma-separated item IDs in inventory
// ---------------------------------------------------------------------------

router.get("/debug/resource-access", async (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  const itemParam = typeof req.query.item === "string" ? req.query.item.trim() : "";
  if (!itemParam) {
    res.status(400).json({ error: "?item=<itemId or name> is required" });
    return;
  }

  // Parse skill levels from query params.
  const skills: Record<string, number> = {};
  for (const skill of ["mining", "forestry", "farming", "cooking", "crafting", "business"]) {
    const val = req.query[skill];
    if (typeof val === "string") {
      const n = parseInt(val, 10);
      if (!isNaN(n)) skills[skill] = n;
    }
  }

  // Parse tools= comma-separated item IDs — each gets qty 1 in the inventory.
  const inventory: Record<string, number> = {};
  const toolsParam = typeof req.query.tools === "string" ? req.query.tools : "";
  if (toolsParam) {
    for (const id of toolsParam.split(",").map((s) => s.trim()).filter(Boolean)) {
      inventory[id] = 1;
    }
  }

  // Resolve item: try as-is first (may be a real ID), then search by display name.
  let itemId = itemParam;
  let resolvedName: string | null = null;
  let matchedLibraryItem: any = null;

  try {
    const [allItems, allEntities, allAchievements, nameMap] = await Promise.all([
      fetchItems(), fetchEntities(), fetchAchievements(), fetchLocaleNameMap(),
    ]);

    // If the param doesn't look like an item ID, resolve by display name.
    if (!itemParam.startsWith("itm_")) {
      const resolved = resolveItemName(itemParam, nameMap, allItems, allAchievements);

      if (resolved.kind === "found") {
        itemId = resolved.itemId;
        resolvedName = nameMap[resolved.itemId] ?? null;
        matchedLibraryItem = allItems[resolved.itemId] ?? allEntities[resolved.itemId] ?? null;
      } else if (resolved.kind === "candidates") {
        const errMsg = resolved.rawAmbiguous
          ? `"${itemParam}" matches multiple raw/gatherable items — please be more specific`
          : `"${itemParam}" is ambiguous — please be more specific`;
        res.status(300).json({ error: errMsg, candidates: resolved.items });
        return;
      } else {
        res.status(404).json({
          error: `No item found matching "${itemParam}" — try the exact item ID`,
          localeMapSize: Object.keys(nameMap).length,
        });
        return;
      }
    } else {
      // allEntities fallback: items that live in the entities dict (e.g. clay nodes)
      matchedLibraryItem = allItems[itemId] ?? allEntities[itemId] ?? null;
      resolvedName = nameMap[itemId] ?? matchedLibraryItem?.name ?? matchedLibraryItem?.label ?? null;
    }

    const result = await computeResourceAccess(itemId, inventory, skills, nameMap);

    res.json({
      query: { item: itemParam, resolvedItemId: itemId, resolvedName, skills, inventory },
      result,
      libraryItem: matchedLibraryItem
        ? {
            id: itemId,
            name: matchedLibraryItem.name ?? matchedLibraryItem.label,
            tier: matchedLibraryItem.tier,
            onUse: matchedLibraryItem.onUse,
            requirements: matchedLibraryItem.requirements,
          }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /debug/library-search — recursive string search across raw library data.
// Diagnostic only — identifies which field(s) hold display names in the live
// library so matchers can be pointed at the right path.
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
//
// Query params:
//   q=<text>   — required, case-insensitive substring to search for
// ---------------------------------------------------------------------------

/**
 * Walk every string value in an arbitrary JSON object and return the dot-paths
 * where the query appears (case-insensitive). Array indices are included as
 * [N]. Depth-capped at 12 to guard against pathological nesting.
 */
function collectMatchPaths(
  obj: unknown,
  query: string,
  prefix = "",
  depth = 0,
): string[] {
  if (depth > 12) return [];
  const q = query.toLowerCase();

  if (typeof obj === "string") {
    return obj.toLowerCase().includes(q) ? [prefix || "(root)"] : [];
  }
  if (Array.isArray(obj)) {
    const found: string[] = [];
    obj.forEach((item, i) =>
      found.push(...collectMatchPaths(item, query, `${prefix}[${i}]`, depth + 1)),
    );
    return found;
  }
  if (obj && typeof obj === "object") {
    const found: string[] = [];
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      found.push(
        ...collectMatchPaths(v, query, prefix ? `${prefix}.${k}` : k, depth + 1),
      );
    }
    return found;
  }
  return [];
}

router.get("/debug/library-search", async (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "?q=<text> is required" });
    return;
  }

  const kind = typeof req.query.kind === "string" ? req.query.kind.toLowerCase() : "all";

  try {
    const [allItems, allEntities, allAchievements] = await Promise.all([
      fetchItems(), fetchEntities(), fetchAchievements(),
    ]);

    // First 2 raw items as structural samples regardless of query.
    const sampleItems = Object.entries(allItems)
      .slice(0, 2)
      .map(([id, item]) => ({
        id,
        topLevelKeys: Object.keys(item as Record<string, unknown>),
        rawTruncated: JSON.stringify(item).slice(0, 800),
      }));

    type SearchMatch = {
      kind: "item" | "entity" | "achievement";
      id: string;
      topLevelKeys: string[];
      matchPaths: string[];
      rawTruncated: string;
    };

    const allMatches: SearchMatch[] = [];

    if (kind === "all" || kind === "item") {
      for (const [id, item] of Object.entries(allItems)) {
        if (allMatches.filter((m) => m.kind === "item").length >= 10) break;
        const paths = collectMatchPaths(item, q);
        if (paths.length > 0) allMatches.push({ kind: "item", id, topLevelKeys: Object.keys(item as Record<string, unknown>), matchPaths: paths, rawTruncated: JSON.stringify(item).slice(0, 800) });
      }
    }

    if (kind === "all" || kind === "entity") {
      for (const [id, entity] of Object.entries(allEntities)) {
        if (allMatches.filter((m) => m.kind === "entity").length >= 10) break;
        const paths = collectMatchPaths(entity, q);
        if (paths.length > 0) allMatches.push({ kind: "entity", id, topLevelKeys: Object.keys(entity as Record<string, unknown>), matchPaths: paths, rawTruncated: JSON.stringify(entity).slice(0, 800) });
      }
    }

    if (kind === "all" || kind === "achievement") {
      for (const [id, ach] of Object.entries(allAchievements)) {
        if (allMatches.filter((m) => m.kind === "achievement").length >= 10) break;
        const paths = collectMatchPaths(ach, q);
        if (paths.length > 0) allMatches.push({ kind: "achievement", id, topLevelKeys: Object.keys(ach as Record<string, unknown>), matchPaths: paths, rawTruncated: JSON.stringify(ach).slice(0, 1200) });
      }
    }

    res.json({
      query: q,
      kind,
      totalItemsSearched: Object.keys(allItems).length,
      totalEntitiesSearched: Object.keys(allEntities).length,
      totalAchievementsSearched: Object.keys(allAchievements).length,
      sampleItems,
      matches: allMatches,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /debug/achievement — dump raw achievement entry by key or name fragment.
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
//
// Query params:
//   q=<text>  — required; matched against achievement ID and raw JSON content
// ---------------------------------------------------------------------------

router.get("/debug/achievement", async (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) {
    res.status(400).json({ error: "?q=<achievement key or name fragment> is required" });
    return;
  }

  try {
    const allAchievements = await fetchAchievements();
    const lower = q.toLowerCase();
    const hits: Array<{ id: string; raw: unknown }> = [];

    for (const [id, ach] of Object.entries(allAchievements)) {
      if (id.toLowerCase().includes(lower) || JSON.stringify(ach).toLowerCase().includes(lower)) {
        hits.push({ id, raw: ach });
        if (hits.length >= 5) break;
      }
    }

    res.json({
      query: q,
      totalAchievements: Object.keys(allAchievements).length,
      hits,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /debug/catalog — query the precomputed game_catalog table.
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
//
// Query params:
//   item=<itemId>           — single row by item_id
//   name=<text>             — single row by display name (exact, case-insensitive)
//   industry=<mine|farm...> — filter by industry
//   tier=<N>                — filter by tier
//   skill=<farming|...>     — filter by skill
//   category=<crafted|crop|gathered>
//   limit=<N>               — max rows (default 100)
// ---------------------------------------------------------------------------

router.get("/debug/catalog", async (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  try {
    // If catalog is empty, trigger a build first
    const count = countCatalogRows();
    let buildMsg: string | null = null;
    if (count === 0) {
      const buildResult = await rebuildCatalogIfNeeded();
      buildMsg = buildResult.message;
    }

    const filter: Parameters<typeof queryCatalog>[0] = {};
    let resolvedItemNote: string | undefined;

    // ?item= accepts: exact item_id, display name (case-insensitive), or typo (DL≤2 fuzzy)
    if (typeof req.query.item === "string" && req.query.item) {
      const itemParam = req.query.item.trim();
      const exactRow = getCatalogRow(itemParam);
      if (exactRow) {
        filter.itemId = itemParam;
      } else {
        // Try case-insensitive display name
        const allRows = queryCatalog({ limit: 10000 });
        const nameLower = itemParam.toLowerCase();
        const nameMatch = allRows.find(r => r.display_name.toLowerCase() === nameLower);
        if (nameMatch) {
          filter.itemId = nameMatch.item_id;
          resolvedItemNote = `matched display name "${nameMatch.display_name}" → ${nameMatch.item_id}`;
        } else {
          // Try fuzzy DL≤2
          const fuzzyMatch = fuzzyResolveName(itemParam, 2);
          if (fuzzyMatch) {
            filter.itemId = fuzzyMatch.itemId;
            resolvedItemNote = `fuzzy match (distance ${fuzzyMatch.distance}): "${fuzzyMatch.displayName}" → ${fuzzyMatch.itemId}`;
          } else {
            filter.itemId = itemParam; // will return empty — no match
            resolvedItemNote = `no match found for "${itemParam}"`;
          }
        }
      }
    }

    if (typeof req.query.industry === "string" && req.query.industry) filter.industry = req.query.industry;
    if (typeof req.query.tier === "string" && req.query.tier) {
      const t = parseInt(req.query.tier, 10);
      if (!isNaN(t)) filter.tier = t;
    }
    if (typeof req.query.skill === "string" && req.query.skill) filter.skill = req.query.skill;
    if (typeof req.query.category === "string" && req.query.category) filter.category = req.query.category;
    if (typeof req.query.limit === "string") {
      const l = parseInt(req.query.limit, 10);
      if (!isNaN(l) && l > 0) filter.limit = Math.min(l, 500);
    }

    // Legacy ?name= param: exact display name match
    if (typeof req.query.name === "string" && req.query.name && !filter.itemId) {
      const nameQ = (req.query.name as string).toLowerCase();
      const allRows = queryCatalog({ limit: 10000 });
      const nameMatch = allRows.find(r => r.display_name.toLowerCase() === nameQ);
      if (nameMatch) filter.itemId = nameMatch.item_id;
    }

    const rows = queryCatalog(filter);
    const totalRows = countCatalogRows();

    res.json({
      totalCatalogRows: totalRows,
      buildMsg: buildMsg ?? undefined,
      resolvedItemNote,
      filter,
      count: rows.length,
      rows,
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /debug/catalog/rebuild — force a full catalog rebuild.
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
// ---------------------------------------------------------------------------

router.get("/debug/catalog/rebuild", async (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  try {
    const result = await rebuildCatalogIfNeeded(true);
    res.json({
      ...result,
      totalCatalogRows: countCatalogRows(),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /debug/locale-new — list _name keys first seen within the last N days.
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
//
// Query params:
//   days=<N>  — look-back window in days (default 7, max 365)
// ---------------------------------------------------------------------------

import { getNewLocaleNameKeys, STATIC_DIR } from "../db/database";

// ---------------------------------------------------------------------------
// GET /debug/guides — inspect static guide loading and detection.
// Protected by ?key= query param (DEBUG_KEY env var — disabled if unset).
//
// Query params:
//   q=<question>  — optional; runs detectGuideId + extractGuideSection on it
// ---------------------------------------------------------------------------

router.get("/debug/guides", (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  const tipsJsonPath = `${STATIC_DIR}/tips.json`;
  const guidesJsonPath = `${STATIC_DIR}/guides.json`;

  const guides = listGuides();
  const tips = listAllTips();

  const result: Record<string, unknown> = {
    staticDir: STATIC_DIR,
    tipsJsonPath,
    guidesJsonPath,
    tipsCount: tips.length,
    guidesCount: guides.length,
    guideIds: guides.map((g) => g.id),
  };

  const q = typeof req.query.q === "string" ? req.query.q.trim() : null;
  if (q) {
    const cleanQ = q.replace(/[?!.,;:'"]+/g, " ");
    const detectedId = detectGuideId(cleanQ);
    result.query = q;
    result.detectedGuideId = detectedId;
    if (detectedId) {
      const guide = guides.find((g) => g.id === detectedId);
      if (guide) {
        result.guideTitle = guide.title;
        result.section = extractGuideSection(guide.content, cleanQ);
      } else {
        result.guideFound = false;
        result.warning = `guideId "${detectedId}" detected but NOT in DB — static data missing`;
      }
    }
  }

  res.json(result);
});

// ---------------------------------------------------------------------------
// POST /api/activity-timers — upsert timers from the extension.
// GET  /api/activity-timers — list all active timers for a player.
// ---------------------------------------------------------------------------

router.post("/api/activity-timers", (req: Request, res: Response) => {
  const body = req.body as { playerId?: unknown; timers?: unknown };
  const pid = typeof body.playerId === "string" && body.playerId.trim() ? body.playerId.trim() : null;
  if (!pid) { res.status(400).json({ error: "playerId required" }); return; }
  if (!Array.isArray(body.timers)) { res.status(400).json({ error: "timers array required" }); return; }
  let saved = 0;
  for (const t of (body.timers as Record<string, unknown>[])) {
    const mid         = typeof t.entityMid   === "string" ? t.entityMid   : null;
    const entityLabel = typeof t.entityLabel === "string" ? t.entityLabel : "";
    const itemLabel   = typeof t.itemLabel   === "string" ? t.itemLabel   : "";
    const landLabel   = typeof t.landLabel   === "string" ? t.landLabel   : "";
    const mapId       = typeof t.mapId       === "string" ? t.mapId       : "";
    const startedAt   = typeof t.startedAt   === "number" ? t.startedAt   : 0;
    const readyAt     = typeof t.readyAt     === "number" ? t.readyAt     : 0;
    if (mid && readyAt > 0) {
      try { upsertActivityTimer(pid, mid, entityLabel, itemLabel, landLabel, mapId, startedAt, readyAt); saved++; }
      catch { /* non-fatal */ }
    }
  }
  res.json({ saved });
});

router.get("/api/activity-timers", (req: Request, res: Response) => {
  const pid = typeof req.query.playerId === "string" && req.query.playerId.trim() ? req.query.playerId.trim() : null;
  if (!pid) { res.status(400).json({ error: "playerId query param required" }); return; }
  const timers = listActivityTimers(pid);
  res.json({ timers });
});

router.post("/api/activity-timers/collected", (req: Request, res: Response) => {
  const body = req.body as { playerId?: unknown; entityMid?: unknown };
  const pid = typeof body.playerId === "string" && body.playerId.trim() ? body.playerId.trim() : null;
  const mid = typeof body.entityMid === "string" && body.entityMid.trim() ? body.entityMid.trim() : null;
  if (!pid || !mid) { res.status(400).json({ error: "playerId and entityMid required" }); return; }
  markActivityTimerCollected(pid, mid);
  res.json({ ok: true });
});

router.get("/debug/locale-new", (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).json({ error: "Forbidden — provide ?key=<DEBUG_KEY>" });
    return;
  }

  const daysRaw = parseInt(String(req.query.days ?? "7"), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 365) : 7;
  const sinceMs = Date.now() - days * 24 * 60 * 60_000;

  try {
    const rows = getNewLocaleNameKeys(sinceMs);
    res.json({
      days,
      since: new Date(sinceMs).toISOString(),
      count: rows.length,
      keys: rows.map((r) => ({
        key: r.key,
        displayName: r.text,
        firstSeen: new Date(r.first_seen).toISOString(),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// GET /api/debug/answer-tests?key=<DEBUG_KEY>
// Returns immediately with DB diagnostics at the top, then shows test results
// from the background run (or a "running — refresh soon" banner).
// Protected by DEBUG_KEY env var (403 if missing or wrong key).
// ?force=1 triggers a fresh run even when results already exist.
// ---------------------------------------------------------------------------

import { ANSWER_TEST_CASES, TEST_CONTEXT } from "./answerTestCases";

// ---------------------------------------------------------------------------
// In-process dispatch — calls the /ask handler directly without HTTP.
// Moved to module scope so the background runner can call it.
// ---------------------------------------------------------------------------
function dispatchAskInProcess(question: string, context: unknown): Promise<string> {
  return new Promise<string>((resolve) => {
    let settled = false;
    const done = (val: string) => { if (!settled) { settled = true; resolve(val); } };

    const fakeReq = {
      body:    { question, context },
      query:   {},
      headers: {},
      get:     (_h: string) => undefined,
      ip:      "127.0.0.1",
    } as unknown as Request;

    const fakeRes = {
      json:      (data: unknown) => {
        const d = data as Record<string, unknown>;
        done(typeof d?.answer === "string" ? d.answer : JSON.stringify(data));
        return fakeRes;
      },
      status:    (_code: number) => fakeRes,
      send:      (data: unknown) => { done(String(data)); return fakeRes; },
      setHeader: () => fakeRes,
      set:       () => fakeRes,
    } as unknown as Response;

    const layer = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: Function }> } }> }).stack
      .find(l => l?.route?.path === "/ask" && l?.route?.methods?.post);
    const handler = layer?.route?.stack?.[0]?.handle;
    if (handler) {
      Promise.resolve(handler(fakeReq, fakeRes, (err?: unknown) => done(`[next: ${err ?? "no response"}]`)))
        .catch(e => done(`[handler threw: ${e}]`));
    } else {
      done("[ask handler not found in router.stack]");
    }

    // Inner safety net — outer race at 20 s wins first for timeouts.
    setTimeout(() => done("[no response after 25s]"), 25_000);
  });
}

// ---------------------------------------------------------------------------
// Background test runner state (survives across requests, resets on restart).
// ---------------------------------------------------------------------------
interface AnswerTestResult {
  label:      string;
  question:   string;
  answer:     string;
  passed:     boolean;
  failures:   string[];
  model?:     string;
  durationMs?: number;
}
interface AnswerTestRun {
  startedAt:   string;
  finishedAt:  string | null;
  results:     AnswerTestResult[];
}
let _answerTestRun: AnswerTestRun | null = null;
let _answerTestRunning = false;

async function startAnswerTestRun(): Promise<void> {
  if (_answerTestRunning) return;
  _answerTestRunning = true;
  const run: AnswerTestRun = { startedAt: new Date().toISOString(), finishedAt: null, results: [] };
  _answerTestRun = run;

  for (const tc of ANSWER_TEST_CASES) {
    let answer = "";
    resetLastUsedModel();
    const t0 = Date.now();
    try {
      answer = await Promise.race([
        dispatchAskInProcess(tc.question, TEST_CONTEXT),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("TEST_TIMEOUT")), 20_000)),
      ]);
    } catch (e) {
      answer = String(e).includes("TEST_TIMEOUT") ? "[TIMEOUT after 20s]" : `[ERROR: ${e}]`;
    }
    const durationMs = Date.now() - t0;
    const model = getLastUsedModel() !== "none" ? getLastUsedModel() : undefined;
    const failures: string[] = [];
    for (const c of tc.checks) {
      const ok = typeof c === "string"
        ? answer.toLowerCase().includes(c.toLowerCase())
        : c.test(answer);
      if (!ok) failures.push(`missing: ${c}`);
    }
    for (const c of tc.notChecks ?? []) {
      const found = typeof c === "string"
        ? answer.toLowerCase().includes(c.toLowerCase())
        : c.test(answer);
      if (found) failures.push(`found (should be absent): ${c}`);
    }
    run.results.push({ label: tc.label, question: tc.question, answer, passed: failures.length === 0, failures, model, durationMs });
  }

  run.finishedAt = new Date().toISOString();
  _answerTestRunning = false;
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
router.get("/api/debug/answer-tests", (req: Request, res: Response) => {
  const expectedKey = process.env.DEBUG_KEY ?? "";
  if (!expectedKey || req.query.key !== expectedKey) {
    res.status(403).send("Forbidden — provide ?key=<DEBUG_KEY>");
    return;
  }

  // ── HTML helpers ──────────────────────────────────────────────────────────
  function escHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Instant DB queries (no LLM) ───────────────────────────────────────────
  type DiagRow          = { land_id: string; tiers_available: string; entities: string };
  type FarmDiagRow      = DiagRow & { soil_count: number | null };
  type LandReportDiagRow = { land_id: string; observed_at: number; soil_tiers: string; industries_preview: string };

  const stoneRows = db.prepare<[], DiagRow>(`
    SELECT land_id, tiers_available, entities FROM land_placements
    WHERE EXISTS (SELECT 1 FROM json_each(entities) WHERE value LIKE '%stone%' OR value LIKE '%kiln%')
    ORDER BY last_crawled DESC LIMIT 5
  `).all();
  const farmRows = db.prepare<[], FarmDiagRow>(`
    SELECT land_id, tiers_available, entities, soil_count FROM land_placements
    WHERE soil_count IS NOT NULL AND soil_count > 0
    ORDER BY last_crawled DESC LIMIT 5
  `).all();
  const landReportRows = db.prepare<[], LandReportDiagRow>(`
    SELECT land_id, observed_at, soil_tiers, substr(industries, 1, 800) as industries_preview
    FROM land_reports ORDER BY observed_at DESC LIMIT 8
  `).all();
  const land486Row = db.prepare<[], LandReportDiagRow>(`
    SELECT land_id, observed_at, soil_tiers, substr(industries, 1, 800) as industries_preview
    FROM land_reports WHERE land_id = 'pixelsNFTFarm-486'
  `).get() ?? null;

  function diagStoneTable(rows: DiagRow[]): string {
    if (rows.length === 0) return `<p><em>No stoneshaping lands in DB</em></p>`;
    return `<table><thead><tr><th>Land ID</th><th>tiers_available</th><th>Matching entities (stone/kiln)</th></tr></thead><tbody>` +
      rows.map(r => {
        const ents: string[] = (() => { try { return JSON.parse(r.entities); } catch { return []; } })();
        const matching = ents.filter(e => /stone|kiln/i.test(e));
        return `<tr><td>${r.land_id}</td><td><code>${escHtml(r.tiers_available)}</code></td><td><code>${escHtml(matching.join(", "))}</code></td></tr>`;
      }).join("") + `</tbody></table>`;
  }

  function diagFarmTable(rows: FarmDiagRow[]): string {
    if (rows.length === 0) return `<p><em>No farming lands in DB (soil_count &gt; 0)</em></p>`;
    return `<p><em>Soil spots come from soil_count column. Soil tier inferred from tiers_available labels only (until companion data arrives).</em></p>` +
      `<table><thead><tr><th>Land ID</th><th>soil_count</th><th>tiers_available</th></tr></thead><tbody>` +
      rows.map(r =>
        `<tr><td>${r.land_id}</td><td>${r.soil_count ?? "null"}</td><td><code>${escHtml(r.tiers_available)}</code></td></tr>`
      ).join("") + `</tbody></table>`;
  }

  function diagLandReportsTable(rows: LandReportDiagRow[], spotlight: LandReportDiagRow | null): string {
    const soilNote = `<p><em>soil_tiers: per-tier soil count from room.state.entities (companion extension). {} = land not yet visited by a companion user, or no soil entities detected.</em></p>`;
    if (rows.length === 0 && !spotlight) return soilNote + `<p><em>No land_reports rows yet.</em></p>`;
    const spotlightHtml = spotlight
      ? `<p><strong>Land 486:</strong> soil_tiers = <code>${escHtml(spotlight.soil_tiers)}</code> &nbsp;·&nbsp; observed ${new Date(spotlight.observed_at).toISOString()}<br>
         industries (soil): <code>${escHtml((() => {
           try {
             const ind = JSON.parse(spotlight.industries_preview) as Array<{entityTypeId?: string}>;
             return JSON.stringify(ind.filter(e => e.entityTypeId?.toLowerCase().includes("soil")));
           } catch { return spotlight.industries_preview; }
         })())}</code></p>`
      : `<p><em>Land 486 not yet visited by a companion user.</em></p>`;

    const tableHtml = rows.length === 0 ? "" :
      `<table><thead><tr><th>Land ID</th><th>Observed</th><th>soil_tiers (total)</th><th>Soil entityTypeIds in industries[]</th></tr></thead><tbody>` +
      rows.map(r => {
        const tierTotal = (() => { try { return Object.values(JSON.parse(r.soil_tiers) as Record<string, number>).reduce((s, n) => s + n, 0); } catch { return "?"; } })();
        const soilIds   = (() => {
          try {
            const ind = JSON.parse(r.industries_preview) as Array<{entityTypeId?: string}>;
            return ind.filter(e => e.entityTypeId?.toLowerCase().includes("soil")).map(e => e.entityTypeId).join(", ");
          } catch { return "(parse error)"; }
        })();
        return `<tr><td>${r.land_id}</td><td>${new Date(r.observed_at).toISOString().slice(0, 19)}</td><td><code>${escHtml(r.soil_tiers)}</code> (${tierTotal})</td><td><code>${escHtml(soilIds || "none")}</code></td></tr>`;
      }).join("") + `</tbody></table>`;
    return soilNote + spotlightHtml + tableHtml;
  }

  // ── Background run trigger ─────────────────────────────────────────────────
  const forceRun = req.query.force === "1";
  if (!_answerTestRunning && (!_answerTestRun || forceRun)) {
    startAnswerTestRun(); // fire-and-forget; results accumulate in _answerTestRun
  }

  // ── Build test-results section from in-memory state ───────────────────────
  const keyParam = escHtml(String(req.query.key ?? ""));
  let summaryHtml: string;
  let testTableHtml: string;

  function buildResultsTable(results: AnswerTestResult[]): string {
    if (results.length === 0) return `<p><em>No results yet.</em></p>`;
    return `<table>
<thead><tr>
  <th style="width:50px"></th>
  <th style="width:220px">Test</th>
  <th style="width:220px">Question</th>
  <th style="width:120px">Model</th>
  <th style="width:60px">Time</th>
  <th>Answer</th>
</tr></thead>
<tbody>` +
      results.map(r => {
        const bg       = r.passed ? "#f0fdf4" : (r.answer.startsWith("[TIMEOUT") ? "#fefce8" : "#fef2f2");
        const badge    = r.passed
          ? `<span style="color:#16a34a;font-weight:700">PASS</span>`
          : r.answer.startsWith("[TIMEOUT") ? `<span style="color:#ca8a04;font-weight:700">TIMEOUT</span>`
          : `<span style="color:#dc2626;font-weight:700">FAIL</span>`;
        const failDetail = r.failures.length
          ? `<ul style="margin:4px 0 0 16px;color:#dc2626">${r.failures.map(f => `<li>${escHtml(String(f))}</li>`).join("")}</ul>`
          : "";
        const modelLabel = r.model
          ? escHtml(r.model.replace("groq/llama-3.3-70b-versatile", "Groq 70B").replace("gemini/gemini-1.5-flash", "Gemini Flash").replace(/^local\//, "Local/"))
          : `<span style="color:#94a3b8">code</span>`;
        const timeLabel = r.durationMs !== undefined
          ? r.durationMs >= 1000 ? `${(r.durationMs / 1000).toFixed(1)}s` : `${r.durationMs}ms`
          : "";
        return `<tr style="background:${bg}">
      <td style="padding:6px 8px">${badge}</td>
      <td style="padding:6px 8px;font-weight:600">${escHtml(r.label)}</td>
      <td style="padding:6px 8px;font-family:monospace;font-size:12px">${escHtml(r.question)}</td>
      <td style="padding:6px 8px;font-size:11px;color:#475569">${modelLabel}</td>
      <td style="padding:6px 8px;font-size:11px;color:#475569;text-align:right">${escHtml(timeLabel)}</td>
      <td style="padding:6px 8px;font-size:13px;max-width:500px;white-space:pre-wrap">${escHtml(r.answer)}${failDetail}</td>
    </tr>`;
      }).join("\n") + `</tbody></table>`;
  }

  if (_answerTestRunning) {
    const done    = _answerTestRun?.results.length ?? 0;
    const total   = ANSWER_TEST_CASES.length;
    const passed  = _answerTestRun?.results.filter(r => r.passed).length ?? 0;
    const estMins = Math.ceil(((total - done) * 20) / 60);
    summaryHtml   = `<div class="summary running">⏳ Running… ${done}/${total} done (${passed} passed so far) — refresh in ~${estMins} min</div>`;
    testTableHtml = buildResultsTable(_answerTestRun?.results ?? []);
  } else if (_answerTestRun?.finishedAt) {
    const passed  = _answerTestRun.results.filter(r => r.passed).length;
    const failed  = _answerTestRun.results.filter(r => !r.passed).length;
    const total   = _answerTestRun.results.length;
    const color   = failed === 0 ? "#22c55e" : "#ef4444";
    summaryHtml   = `<div class="summary" style="color:${color}">${passed}/${total} passed — finished ${_answerTestRun.finishedAt} &nbsp;<a href="?key=${keyParam}&amp;force=1" style="font-size:0.75em;font-weight:400;margin-left:10px">re-run</a></div>`;
    testTableHtml = buildResultsTable(_answerTestRun.results);
  } else {
    // Just kicked off — results not ready yet
    summaryHtml   = `<div class="summary running">⏳ Test run started — refresh in ~${Math.ceil(ANSWER_TEST_CASES.length * 20 / 60)} min</div>`;
    testTableHtml = `<p><em>No results yet — first run in progress.</em></p>`;
  }

  // ── Render page ───────────────────────────────────────────────────────────
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<title>Answer Tests</title>
<style>
  body{font-family:system-ui,sans-serif;margin:24px;background:#f9fafb;color:#111}
  h1{margin:0 0 4px}
  .summary{font-size:1.4rem;font-weight:700;margin:8px 0 20px}
  .summary.running{color:#b45309}
  table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 3px #0001}
  th{background:#1e293b;color:#fff;padding:8px 10px;text-align:left;font-size:13px}
  td{border-top:1px solid #e5e7eb;vertical-align:top}
  h2{margin:28px 0 8px;font-size:1.1rem}
  code{background:#f1f5f9;padding:1px 4px;border-radius:3px;font-size:12px}
</style>
</head><body>
<h1>Answer regression tests</h1>

<h2>Step 1 — land_reports: companion-visited lands with soil tier data</h2>
${diagLandReportsTable(landReportRows, land486Row)}

<h2>Land-tier diagnostics — stoneshaping lands (raw DB)</h2>
${diagStoneTable(stoneRows)}

<h2>Land-tier diagnostics — farming lands (raw DB, soil_count &gt; 0)</h2>
${diagFarmTable(farmRows)}

<hr style="margin:28px 0;border:none;border-top:2px solid #e5e7eb">

${summaryHtml}
${testTableHtml}

</body></html>`);
});

export default router;
