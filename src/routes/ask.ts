import { Router, Request, Response } from "express";
import { db, WikiEntry, getUpcomingThresholds, listActiveGoals, runDailyDiary, insertShoppingItem, listShoppingItems, deleteShoppingItem, recordTaskboardEvent, insertNotebookGoal, listNotebookGoals, deleteNotebookGoal, updateNotebookGoal, listAllTips, listGuides } from "../db/database";
import { askOllama, OllamaUnavailableError } from "../services/ollama";
import { fetchItems, fetchAchievements, fetchLocaleNameMap } from "../services/gameLibrary";
import { computeCraftEfficiency } from "./craftEfficiency";
import { computeBestActions, BestActionsResult } from "../services/strategy";
import { findItemsInQuestion, formatItemDataSection, resolveItemName, computeCraftingBreakdown, formatCraftingMathSection, buildHarvestMap, RecursiveLeaf } from "../services/itemLookup";
import { computeResourceAccess } from "../services/resourceAccess";
import { fetchEntities } from "../services/gameLibrary";
import { getCatalogRow, countCatalogRows } from "../db/database";
import { generateFastAnswer, fuzzyResolveName, queryCatalog, rebuildCatalogIfNeeded } from "../services/gameCatalog";
import { computeCoinStrategy } from "../services/coinStrategy";
import { rephraseWithValidation } from "../services/rephraseValidator";
import { findReadyLands, resolveIndustry, resolveLandType, formatReadyLandsAnswer, isPlayerThrottled, recordPlayerSearch, getThrottleSecondsLeft } from "../services/landReadyFinder";

const router = Router();

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
    energyMax?: unknown;  // 1000 base + VIP bonus; sent alongside energy
    taskboardCapturedAt?: unknown;    // ms timestamp of last live taskboard read
    taskboardExpiresAt?: unknown;     // ms timestamp when taskboard refreshes
    stackedOffersCapturedAt?: unknown; // ms timestamp of last live stacked read
    _authToken?: unknown;             // game session token (kept for backend fallback)
    marketPrices?: unknown;           // { itemId: {lowestPrice, quantity} } — extension-fetched
    storageChests?: unknown;          // { [mid]: { items: [{itemId, qty}], size, capturedAt } }
  };
  nearbyEntities?: unknown[];
  marketPrices?: Record<string, MarketPriceStat>;
  goals?: unknown;
  sociabilityLevel?: unknown;
  timezone?: unknown;
  persona?: unknown;
  walletAddress?: unknown;
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
  const parts = Object.entries(map).map(([skill, lvl]) => {
    const label = skill
      .replace(/([A-Z])/g, " $1")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    return `${label} ${lvl}`;
  });
  return parts.length > 0 ? `Levels: ${parts.join(", ")}` : null;
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
    const label = skill
      .replace(/([A-Z])/g, " $1")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    return `${label} (${lvl})`;
  });
  return `Weakest skills (ground truth, use these if mentioning skill balance): ${weakest.join(", ")}`;
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
    if (trust !== null) lines.push(`Trust score: ${trust}`);
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
  const tz = strOrNull(ctx.timezone);
  if (tz) lines.push(`Timezone: ${tz}`);
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
const COIN_EARNING_RE =
  /\b(?:how\s+(?:do\s+i|to|can\s+i)\s+(?:make|earn|get)\s+(?:more\s+)?coins?|make\s+more\s+coins?|earn(?:ing)?\s+(?:more\s+)?coins?|get\s+more\s+coins?|best\s+way\s+to\s+(?:earn|make|get)\s+(?:more\s+)?coins?|(?:more\s+)?coins?\s+(?:income|earning|strategy|farming|per\s+day|fast)|how\s+(?:do\s+i|can\s+i)\s+(?:make|earn)\s+(?:more\s+)?(?:money|gold))\b/i;

// Pixel-earning question detector — routes to a dedicated pixel fast path.
const PIXEL_EARNING_RE =
  /\b(?:how\s+(?:do\s+i|to|can\s+i)\s+(?:make|earn|get|farm)\s+(?:more\s+)?pixels?|make\s+more\s+pixels?|earn(?:ing)?\s+(?:more\s+)?pixels?|get\s+more\s+pixels?|best\s+way\s+to\s+(?:earn|make|get)\s+pixels?|pixels?\s+(?:income|earning|farming|source|sources|farm))\b/i;

// Stacked-offers question detector — lists ALL offers (even ineligible) in code.
const STACKED_OFFERS_RE =
  /\b(?:how\s+many|what|which|list|show|all|pending)\b.*\bstacked\b|\bstacked\b.*\boffers?\b|\bdo\s+i\s+have\b.*\boffers?\b/i;

// Stacked App general question — "do i have stacked app", "what is stacked app"
const STACKED_APP_RE =
  /\bstacked\s+app\b|\bdo\s+i\s+have\s+(?:the\s+)?stacked\b|\bwhat(?:'s|\s+is)\s+(?:the\s+)?stacked\s+app\b|\bhow\s+does\s+(?:the\s+)?stacked\b/i;

// Taskboard best-item question — "which/what/best item to craft on my taskboard"
const TASKBOARD_BEST_RE =
  /\b(?:best|which|what)\b.{0,50}\b(?:item|order|thing|task)\b.{0,50}\b(?:craft|make|do|fill|deliver|taskboard)\b|\b(?:best|which)\b.{0,30}\btaskboard\b.{0,50}\b(?:craft|make|order|item)\b/i;

// Taskboard inventory check — "do I have items for taskboard", "what can I deliver"
const TASKBOARD_HAVE_RE =
  /\b(?:do\s+i\s+have|have\s+(?:i|any)|what\s+(?:do\s+i\s+have|can\s+i\s+deliver|am\s+i\s+missing)|can\s+i\s+(?:fill|deliver)|what(?:'s|\s+is)\s+(?:in|missing))\b.{0,60}\b(?:taskboard|task\s+board|orders?)\b|\b(?:taskboard|task\s+board)\b.{0,60}\b(?:do\s+i\s+have|have|deliver|missing|inventory|storage|backpack)\b|\bwhat\s+(?:items?\s+)?(?:do\s+i\s+have\s+for|can\s+i\s+deliver\s+(?:on|to)?)\b.{0,30}\b(?:taskboard|task\s+board|orders?)\b/i;

// Land ready-finder — "where can I mine tier 3 on water land", "find a free farm"
const LAND_READY_RE =
  /\b(?:where\s+can\s+i|find(?:ing)?\s+(?:a\s+|some\s+)?(?:free|public|open|ready|available)?|which\s+lands?|free\s+lands?|available\s+lands?|lands?\s+with(?:\s+a)?\s+|open\s+lands?\s+for)\b.{0,60}\b(?:mine|mining|woodwork|woodworking|forestry|chop(?:ping)?|farm(?:ming)?|cook(?:ing)?|stoneshaping?|fish(?:ing)?|metalwork(?:ing)?|animalcare)\b|\b(?:mine|mining|woodwork|woodworking|forestry|chop(?:ping)?|farm(?:ming)?|cook(?:ing)?|stoneshaping?|fish(?:ing)?|metalwork(?:ing)?|animalcare)\b.{0,60}\b(?:where|which\s+land|free\s+land|available|public\s+land|open\s+land|water\s+land|soil\s+land|space\s+land)\b|\bfree\s+(?:water|soil|grass|space|land)\s+(?:land\s+)?for\b.{0,30}\b(?:mine|mining|woodwork|woodworking|forestry|chop|farm|cook|stone|fish|metal|animal)\b/i;

// Skill XP recipe fast path — "what should I craft to level Stoneshaping"
const SKILL_XP_RE =
  /\b(?:what\s+should\s+i\s+craft\s+to\s+level|what\s+(?:recipe|craft|item)s?\s+(?:give|gives?|best\s+for)\s+(?:the\s+most\s+)?xp|best\s+(?:recipe|craft|item)\s+(?:for|to)\s+(?:level(?:ing)?(?:\s+up)?|gain\s+xp)|most\s+xp\s+(?:from|for|in)|best\s+xp\s+(?:ratio|per\s+energy|recipe|craft)(?:\s+for)?|to\s+level(?:\s+up)?)\b.{0,50}\b(?:stoneshaping|mining|farming|cooking|forestry|metalwork(?:ing)?|woodwork(?:ing)?|fish(?:ing)?|petcare|business|exploration)\b|\b(?:stoneshaping|mining|farming|cooking|forestry|metalwork(?:ing)?|woodwork(?:ing)?|fish(?:ing)?|petcare|business|exploration)\b.{0,50}\b(?:xp|leveling?|level\s+up|best\s+craft|most\s+xp)\b/i;

const SKILL_CANON: Record<string, string> = {
  stoneshaping: "stoneshaping", stone: "stoneshaping",
  mining: "mining", mine: "mining",
  farming: "farming", farm: "farming",
  cooking: "cooking", cook: "cooking",
  forestry: "forestry", woodworking: "woodwork", woodwork: "woodwork", chopping: "forestry",
  metalworking: "metalworking", metalwork: "metalworking",
  fishing: "fishing", fish: "fishing",
  petcare: "petcare", animalcare: "petcare", "animal care": "petcare",
  business: "business",
  exploration: "exploration",
};

function detectSkillXpQuery(q: string): { rawSkill: string; canonicalSkill: string } | null {
  const lq = q.toLowerCase();
  if (!SKILL_XP_RE.test(lq)) return null;
  for (const [alias, canon] of Object.entries(SKILL_CANON)) {
    if (lq.includes(alias)) return { rawSkill: alias, canonicalSkill: canon };
  }
  return null;
}

// Extract land-finder params from a query string
function parseLandReadyQuery(q: string): {
  industry: string | null;
  tier: number | null;
  landType: string | null;
} {
  const lq = q.toLowerCase();

  // Industry
  const industryMatch = lq.match(/\b(mine|mining|woodwork|woodworking|forestry|chop(?:ping)?|farm(?:ming)?|cook(?:ing)?|stoneshapin?g?|fish(?:ing)?|metalwork(?:ing)?|animalcare|animal\s+care)\b/);
  const rawIndustry = industryMatch ? industryMatch[1].replace(/\s+/g, "") : null;
  const industry = rawIndustry ? resolveIndustry(rawIndustry) : null;

  // Tier
  const tierMatch = lq.match(/\btier\s*(\d+)\b/);
  const tier = tierMatch ? parseInt(tierMatch[1], 10) : null;

  // Land type
  const typeMatch = lq.match(/\b(water|soil|grass|space|land)\b/);
  const landType = typeMatch ? resolveLandType(typeMatch[1]) : null;

  return { industry, tier, landType };
}

// Questions where injecting computed taskboard/stacked opportunities is relevant.
// For any other question (guides, item info, features) the section just confuses the model.
const OPPORTUNITIES_RELEVANT_RE =
  /\b(?:earn|make|get)\s+(?:more\s+)?(?:coins?|pixels?)|\bhow\s+(?:do\s+i|to|can\s+i)\s+(?:earn|make|get)\b|\bbest\s+way\s+to\b|\bwhat\s+should\s+i\b|\bwhat\s+can\s+i\s+do\b|\bwhat\s+to\s+(?:do|work|focus|craft)\b|\btaskboard\b|\bstacked\s+offer|\bstrateg|\bbest\s+(?:order|move|action|task)\b|\bwhat\s+to\s+work\b/i;

// Tips question detector — narrow to generic/topic tips, not "tips on crafting X".
const TIPS_RE =
  /\btips?\b|\bhow\s+(?:can\s+i|to)\s+play\s+(?:the\s+game\s+)?better\b/i;

function isTipsQuery(q: string): boolean {
  if (!TIPS_RE.test(q)) return false;
  // Exclude item/topic-specific: "tips for crafting X", "tips on how to", "advice about X"
  if (/\btips?\s+(?:for|on|about|to|when|how)\s/i.test(q)) return false;
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
  // Hearth Hall guide
  if (
    /\bhearth\s*hall\b/.test(lq) &&
    /\b(?:explain|tell|what\s+is|how\s+does|how\s+do|guide|overview|work|faction|offering|sabotage|reactor)\b/.test(lq)
  ) return "hearth_hall";
  // Animal Care guide — general "explain" or specific sub-questions
  if (
    (/\banimal\s*care\b/.test(lq) &&
      /\b(?:explain|tell|what\s+is|how\s+does|how\s+do|guide|overview|work)\b/.test(lq)) ||
    /\bhow\s+(?:do\s+i\s+)?hatch\b|\bhatch(?:ing)?\s+(?:an?\s+)?eggs?\b|\bhatching\b|\bincubators?\b/.test(lq) ||
    /\bbaby\s+animals?\b|\bbaby\s+(?:animal|creature|pet)s?\b|\bget\s+(?:a\s+)?baby\b|\bbabies\b/.test(lq) ||
    /\bgathering\s+basket\b|\bwhat\s+does\s+a\s+baby\b|\bpotion\s+table\b|\bhow\s+(?:do\s+i\s+)?get\s+(?:a\s+)?baby\b/.test(lq)
  ) return "animal_care";
  return null;
}

// For guide sub-questions, return only the paragraphs relevant to the question.
function extractGuideSection(content: string, question: string): string {
  const paragraphs = content.split(/\n\n+/);
  if (paragraphs.length <= 1) return content;
  const lq = question.toLowerCase().replace(/[?!.,;:'"]+/g, " ");

  const isEggQuestion = /\bhatch|\begg\b|\bincubators?\b|\bpotion\b/.test(lq);
  const isBabyQuestion = /\bbaby\s+animals?\b|\bbabies\b|\bwhat\s+does\s+a\s+baby|\bfeeding|\bbasket\b/.test(lq);
  if (!isEggQuestion && !isBabyQuestion) return content;

  const keywords = isEggQuestion
    ? ["hatch", "egg", "incubator", "potion"]
    : ["baby", "feeding", "grow", "basket"];

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
]);

// Single-word feature tokens that shouldn't be resolved as items.
const GAME_FEATURE_WORDS = new Set([
  "stacked", "taskboard", "marketplace", "diary", "notebook", "faction", "guild",
]);

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
- Always use the name "Merchant Boat Contracts", never "Merchant Ships".`;
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
  const SKILL_BALANCE_RE =
    /\b(?:which|weakest|lowest|balance|level\s*up|level\s+my|focus\s+on|train|improve\s+my|boost\s+my|skill\s+to\s+work\s+on)\b/i;
  const weakestSkillsLine =
    Object.keys(levelMap).length >= 3 && SKILL_BALANCE_RE.test(question)
      ? computeWeakestSkills(levelMap)
      : null;

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

  if (craftingMathSection) {
    parts.push("", craftingMathSection);
  }

  parts.push(
    "",
    `Player question: ${question}`,
    "",
    sociabilityInstruction
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

  return { prompt: parts.join("\n"), debug };
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
  kind: "add" | "remove" | "list";
  rawText: string;
  /** Parsed quantity from "add 51 X to my list" — null when not specified. */
  explicitQty: number | null;
}

function detectShoppingListIntent(question: string): ShoppingListIntent | null {
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
// Route
// ---------------------------------------------------------------------------

router.post("/ask", async (req: Request, res: Response) => {
  const body = req.body as { question?: unknown; context?: unknown };
  const { question, context: rawContext } = body;

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
  if (playerId) {
    try {
      runDailyDiary(
        playerId,
        (ctx?.player?.skills ?? ctx?.player?.levels ?? {}) as Record<string, unknown>,
        (ctx?.player?.coins  ?? ctx?.player?.coinInventory ?? {}) as Record<string, unknown>,
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

  // Goals: detect intent in code, handle before LLM.
  const goalIntent = detectGoalIntent(cleanQuestion);
  if (goalIntent) {
    const skillsWithExp = extractSkillsWithExp(ctx?.player?.skills ?? ctx?.player?.levels ?? {});
    const goalResult = await handleGoalAction(goalIntent, playerId, skillsWithExp);
    res.json(goalResult);
    return;
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
      // Return guide content directly — no LLM rephrase to prevent hallucination.
      console.log(`[route] fast:guide id=${guide.id}`);
      res.json({ answer: `${guide.title}\n\n${section}`, debug: { guideFastPath: guide.id } });
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
      const timerPart = timer ? `, ${timer} left` : "";
      lines.push(`- ${req}: ${rewards}${timerPart}${eligibleNote}${urgentNote}`);
    }

    const codeAnswer = lines.join("\n");
    const persona2  = resolvePersona(ctx?.persona);
    const voice2    = PERSONA_VOICE[persona2];
    const finalAnswer2 = await rephraseWithValidation(codeAnswer, voice2, new Set<string>()).catch(() => codeAnswer);
    res.json({ answer: finalAnswer2, debug: { stackedFastPath: true, offerCount: offers.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Pixel-earning fast path — never mixes with coin strategy.
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && PIXEL_EARNING_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const offers: any[] = Array.isArray(p2?.stackedOffers) ? (p2!.stackedOffers as any[]) : [];

    const lines: string[] = ["How to earn Pixels:"];

    if (offers.length > 0) {
      lines.push("\nYour current Stacked App offers:");
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
      }
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
  // Taskboard best-item fast path — "which is the best item to craft on my taskboard"
  // ---------------------------------------------------------------------------
  if (!shoppingIntent && !goalIntent && TASKBOARD_BEST_RE.test(cleanQuestion)) {
    const p2 = ctx?.player;
    const taskboard: any[] = Array.isArray(p2?.taskboard) ? (p2!.taskboard as any[]) : [];

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
    if (!chestsOpened) {
      resultLines.push("\n(I can't see your chests yet — open them once so I can include them.)");
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
  // Skill XP recipe fast path — "what should I craft to level Stoneshaping"
  // ---------------------------------------------------------------------------
  const skillXpMatch = !shoppingIntent && !goalIntent ? detectSkillXpQuery(cleanQuestion) : null;
  if (skillXpMatch) {
    const { canonicalSkill } = skillXpMatch;
    const p2 = ctx?.player;
    const rawSkillsXp = extractSkillsWithExp(p2?.skills ?? p2?.levels ?? {});
    const skillData = rawSkillsXp[canonicalSkill];
    const playerLevel = skillData?.level ?? null;

    const allRecipes = queryCatalog({ skill: canonicalSkill, limit: 200 });
    const craftableRecipes = allRecipes
      .filter(r =>
        r.craft_xp !== null && r.craft_xp > 0 &&
        r.craft_energy !== null && r.craft_energy > 0 &&
        !r.is_event_recipe &&
        (r.level_required === null || playerLevel === null || r.level_required <= playerLevel),
      )
      .map(r => ({ ...r, xpPerEnergy: r.craft_xp! / r.craft_energy! }))
      .sort((a, b) => b.xpPerEnergy - a.xpPerEnergy)
      .slice(0, 8);

    const skillLabel = canonicalSkill.charAt(0).toUpperCase() + canonicalSkill.slice(1);

    if (craftableRecipes.length === 0) {
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

    const xpLines: string[] = [`Best ${skillLabel} recipes by XP per energy${playerLevel ? ` (your level: ${playerLevel})` : ""}:`];
    for (const r of craftableRecipes) {
      const timeStr = r.craft_time_minutes
        ? `, ${r.craft_time_minutes < 1 ? Math.round(r.craft_time_minutes * 60) + "s" : r.craft_time_minutes + "min"}`
        : "";
      const levelNote = r.level_required ? ` (req. level ${r.level_required})` : "";
      let craftNote = "";
      if (goalLevel !== null && goalXpNeeded !== null && r.craft_xp) {
        const craftsNeeded = Math.ceil(goalXpNeeded / r.craft_xp);
        craftNote = ` — ~${craftsNeeded.toLocaleString()} crafts to reach level ${goalLevel}`;
      }
      xpLines.push(`- ${r.display_name}: ${r.craft_xp} XP, ${r.craft_energy} energy${timeStr}, ${r.xpPerEnergy.toFixed(1)} XP/energy${levelNote}${craftNote}`);
    }
    if (goalLevel !== null) {
      const xpNote = goalXpNeeded !== null ? ` — ${goalXpNeeded.toLocaleString()} XP needed` : "";
      xpLines.push(`\nYour goal: reach ${skillLabel} level ${goalLevel}${xpNote}.`);
    } else {
      xpLines.push(`\nTip: say "add reach ${skillLabel} <level> to my goals" to track your progress.`);
    }

    const codeAnswerXp = xpLines.join("\n");
    const personaXp = resolvePersona(ctx?.persona);
    const voiceXp = PERSONA_VOICE[personaXp];
    const finalAnswerXp = await rephraseWithValidation(codeAnswerXp, voiceXp, new Set<string>()).catch(() => codeAnswerXp);
    console.log(`[route] fast:skill-xp skill=${canonicalSkill} recipes=${craftableRecipes.length}`);
    res.json({ answer: finalAnswerXp, debug: { skillXpPath: true, skill: canonicalSkill, recipeCount: craftableRecipes.length } });
    return;
  }

  // ---------------------------------------------------------------------------
  // Land ready-finder fast path — "where can I mine tier 3 on water land"
  // ---------------------------------------------------------------------------
  if (LAND_READY_RE.test(cleanQuestion)) {
    const { industry, tier, landType } = parseLandReadyQuery(cleanQuestion);

    if (industry) {
      // Per-player throttle (use playerId or walletAddress as key)
      const pkey = playerId ?? strOrNull(ctx?.walletAddress);
      if (pkey && isPlayerThrottled(pkey)) {
        const secs = getThrottleSecondsLeft(pkey);
        const throttleMsg = `I need a moment before searching again — try again in about ${secs} seconds.`;
        res.json({ answer: throttleMsg, debug: { landReadyThrottled: true, retryAfterSeconds: secs } });
        return;
      }
      if (pkey) recordPlayerSearch(pkey);

      // Count DB candidates for display
      const tierCond  = tier      !== null ? `AND EXISTS (SELECT 1 FROM json_each(entities) WHERE value GLOB '*_t${tier}')` : "";
      const typeCond  = landType  !== null ? `AND land_type = '${landType}'` : "";
      const countRow  = db
        .prepare(`SELECT COUNT(*) as total FROM land_placements WHERE EXISTS (SELECT 1 FROM json_each(entities) WHERE value LIKE ?) ${tierCond} ${typeCond}`)
        .get(`%${industry}%`) as { total: number } | undefined;
      const totalInDB = countRow?.total ?? 0;

      const guildHandle = typeof ctx?.player?.guildHandle === "string" ? ctx!.player!.guildHandle : undefined;
      const lands = await findReadyLands({ industry, tier: tier ?? undefined, landType: landType ?? undefined, guildHandle, limit: 8 })
        .catch(() => []);

      // Derive user-facing industry name from the original query
      const rawIndustryName = (() => {
        const m = cleanQuestion.toLowerCase().match(/\b(mine|mining|woodwork|woodworking|forestry|chop(?:ping)?|farm(?:ming)?|cook(?:ing)?|stoneshapin?g?|fish(?:ing)?|metalwork(?:ing)?|animalcare|animal\s+care)\b/);
        return m ? m[1] : industry;
      })();

      const codeAnswerLand = formatReadyLandsAnswer({
        lands, industry: rawIndustryName, tier: tier ?? undefined,
        landType: landType ?? undefined, totalInDB,
      });

      const personaLand = resolvePersona(ctx?.persona);
      const voiceLand   = PERSONA_VOICE[personaLand];
      const finalAnswerLand = await rephraseWithValidation(codeAnswerLand, voiceLand, new Set<string>())
        .catch(() => codeAnswerLand);

      console.log(`[route] fast:land-ready industry=${industry} tier=${tier} landType=${landType} found=${lands.length}`);
      res.json({ answer: finalAnswerLand, debug: { landReadyPath: true, industry, tier, landType, totalInDB, landCount: lands.length } });
      return;
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

      const persona2     = resolvePersona(ctx?.persona);
      const voice2       = PERSONA_VOICE[persona2];
      const finalAnswer2 = await rephraseWithValidation(stratResult.codeAnswer, voice2, stratResult.knownItemNames);

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
        if (invResolve.kind === "found") {
          const backpackCount = typeof inv[invResolve.itemId] === "number" ? (inv[invResolve.itemId] as number) : 0;
          const displayName   = fiNameMap2[invResolve.itemId] ?? invResolve.itemId;
          const assumedNote   = invResolve.fuzzyDisplayName ? ` (assuming you meant ${invResolve.fuzzyDisplayName})` : "";

          // Tally storage chests.
          type ChestEntry = { items: Array<{ itemId: string; qty: number }>; capturedAt: number };
          const rawChests = p2?.storageChests && typeof p2.storageChests === "object"
            ? (p2.storageChests as Record<string, ChestEntry>) : null;
          let storageCount = 0;
          let chestsScanned = 0;
          const chestsTotal = rawChests ? Object.keys(rawChests).length : 0;
          if (rawChests) {
            for (const chest of Object.values(rawChests)) {
              if (!Array.isArray(chest.items)) continue;
              chestsScanned++;
              for (const slot of chest.items) {
                if (slot.itemId === invResolve.itemId) storageCount += (slot.qty ?? 0);
              }
            }
          }
          const total = backpackCount + storageCount;
          const chestNote = chestsTotal > 0 && chestsScanned < chestsTotal
            ? ` (only ${chestsScanned} of ${chestsTotal} chests have been opened — open the rest for a full count)`
            : "";
          const noChestNote = chestsTotal === 0 ? " Open your storage chests once so I can read them." : "";

          let invCodeAnswer: string;
          if (invQuery.kind === "count") {
            if (chestsTotal > 0) {
              if (total > 0) {
                invCodeAnswer = `Backpack: ${backpackCount}. Storage chests: ${storageCount}. Total: ${total} ${displayName}.${chestNote}${assumedNote}`;
              } else {
                invCodeAnswer = `You don't have any ${displayName} in your backpack or storage chests.${chestNote}${assumedNote}`;
              }
            } else {
              invCodeAnswer = backpackCount > 0
                ? `You have ${backpackCount} ${displayName} in your backpack.${noChestNote}${assumedNote}`
                : `You don't have any ${displayName} in your backpack.${noChestNote}${assumedNote}`;
            }
          } else {
            if (chestsTotal > 0) {
              invCodeAnswer = total > 0
                ? `Yes — backpack: ${backpackCount}, storage chests: ${storageCount}, total: ${total} ${displayName}.${chestNote}${assumedNote}`
                : `No, you don't have any ${displayName} in your backpack or storage chests.${chestNote}${assumedNote}`;
            } else {
              invCodeAnswer = backpackCount > 0
                ? `Yes, you have ${backpackCount} ${displayName} in your backpack.${noChestNote}${assumedNote}`
                : `No, you don't have any ${displayName} right now.${noChestNote}${assumedNote}`;
            }
          }
          const persona3 = resolvePersona(ctx?.persona);
          const voice3 = PERSONA_VOICE[persona3];
          const finalInvAnswer = await rephraseWithValidation(invCodeAnswer, voice3).catch(() => invCodeAnswer);
          console.log(`[route] fast:inventory item=${invResolve.itemId} backpack=${backpackCount} storage=${storageCount} total=${total}`);
          res.json({ answer: finalInvAnswer, debug: { inventoryFastPath: true, itemId: invResolve.itemId, backpackCount, storageCount, total } });
          return;
        }
      } catch {
        // library unavailable — fall through to LLM
      }
    }
  }

  // Fast-path: catalog fact question — single item, deterministic template answer
  if (!shoppingIntent) {
    const rawLevel0 = ctx?.player?.skills !== undefined || ctx?.player?.levels !== undefined
      ? Object.fromEntries(
          Object.entries((ctx?.player?.skills ?? ctx?.player?.levels ?? {}) as Record<string, unknown>).flatMap(([k, v]) => {
            const lvl = typeof v === "number" ? v : (v && typeof v === "object" ? ((v as Record<string, unknown>).level ?? (v as Record<string, unknown>).current) : null);
            return typeof lvl === "number" ? [[k.toLowerCase(), lvl]] : [];
          })
        )
      : {};
    try {
      const [fiItems, fiAchs, fiNameMap] = await Promise.all([
        fetchItems() as Promise<Record<string, any>>,
        fetchAchievements() as Promise<Record<string, any>>,
        fetchLocaleNameMap(),
      ]);
      // Strip question-wrapper words so "where do i get Clayum Matrix" → "Clayum Matrix"
      // (greetings already stripped by cleanQuestion; only remove the question type prefix here)
      const itemQuery = cleanQuestion
        .replace(/^(?:where\s+(?:do\s+i\s+)?(?:get|find|obtain|buy)|how\s+(?:do\s+i\s+)?(?:get|obtain|find|make|craft|create)|where\s+can\s+i\s+(?:get|find|obtain|buy)|how\s+to\s+(?:get|obtain|find|make|craft))\s+/i, "")
        .replace(/^(?:what\s+is\s+(?:a\s+|an\s+)?|tell\s+me\s+about\s+)/i, "")
        .replace(/^(?:can\s+i\s+(?:farm|mine|chop|gather|harvest|grow|plant|get|obtain|craft|make|cook|brew|build))\s+/i, "")
        .trim();
      // Skip item resolution when the query is about a game feature, not an item.
      if (isGameFeatureQuestion(itemQuery || cleanQuestion)) throw new Error("feature_query");
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
          const fastAnswer = generateFastAnswer(catalogRow, cleanQuestion, rawLevel0, inv);
          if (fastAnswer) {
            const assumedNote = fastResolve.fuzzyDisplayName
              ? ` (assuming you meant ${fastResolve.fuzzyDisplayName})`
              : "";
            const fullFastAnswer = fastAnswer + assumedNote;
            const persona3  = resolvePersona(ctx?.persona);
            const voice3    = PERSONA_VOICE[persona3];
            const rephrasedFast = await rephraseWithValidation(fullFastAnswer, voice3).catch(() => fullFastAnswer);
            console.log(`[route] fast:catalog item=${catalogRow.item_id}`);
            res.json({
              answer: rephrasedFast,
              debug: { fastPath: `catalog row: ${catalogRow.item_id}`, catalogRow },
            });
            return;
          }
        }
      }

      // Item not found — for short queries that look like item names, suggest closest match.
      if (fastResolve.kind === "not_found") {
        const stripped = itemQuery || cleanQuestion;
        // Never trigger fuzzy-match for queries that are actually guide topics
        // (e.g. "baby animals" after stripping "how do i get").
        const isGuideQuery = /\bbaby\s*animals?\b|\bhatching\b|\bincubators?\b|\bbabies\b|\bpotion\s+table\b|\bgathering\s+basket\b|\banimal\s*care\b/.test(stripped.toLowerCase());
        if (
          !isGuideQuery &&
          stripped.split(/\s+/).length <= 5 &&
          !/^(?:how|where|what|which|when|why|do|can|should|is|are)\s/i.test(stripped)
        ) {
          const fuzzyHint = fuzzyResolveName(stripped, 4);
          if (fuzzyHint) {
            const persona3 = resolvePersona(ctx?.persona);
            const voice3   = PERSONA_VOICE[persona3];
            const notFoundCode = `I couldn't find an item called "${stripped}". Did you mean ${fuzzyHint.displayName}?`;
            const notFoundFinal = await rephraseWithValidation(notFoundCode, voice3).catch(() => notFoundCode);
            res.json({ answer: notFoundFinal, debug: { notFound: stripped, fuzzyMatch: fuzzyHint.displayName } });
            return;
          }
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

  try {
    const rawAnswer = await askOllama(prompt, { numPredict: 150 });
    const answer = validateAnswer(rawAnswer);
    if (inventedItemsInAnswer(answer)) {
      res.json({
        answer: "I'm not sure about that one — try asking about a specific item or crafting recipe.",
        debug: { ...debug, inventedItemsRejected: true },
      });
      return;
    }
    res.json({ answer, debug });
  } catch (err) {
    if (err instanceof OllamaUnavailableError) {
      const persona = resolvePersona(ctx?.persona);
      const fallbacks = PERSONA_FALLBACKS[persona];
      res.json({ answer: fallbacks[Math.floor(Math.random() * fallbacks.length)] });
      return;
    }
    throw err;
  }
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

export default router;
