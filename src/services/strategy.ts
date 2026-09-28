import { fetchItems, fetchAchievements, fetchLocaleNameMap } from "./gameLibrary";
import { buildHarvestMap, resolveCraftableRecursive, resolveItemName } from "./itemLookup";
import { fetchMarketPrices, MarketListing } from "./marketplace";
import { getCatalogRow, getMarketPrice } from "../db/database";
import type { CatalogRow } from "../db/database";
import { fuzzyResolveName, rebuildCatalogIfNeeded } from "./gameCatalog";

// ---------------------------------------------------------------------------
// Input types — mirror the shapes emitted by extension/injected.js
// ---------------------------------------------------------------------------

export interface TaskboardItem {
  itemName: string;
  tier: string;
  quantityNeeded: number;
  costs: string[];       // coin-cost / reward strings shown on the card
  isVipLocked: boolean;
  canDeliverNow: boolean;
}

export interface StackedOffer {
  requirementText: string;
  timerText: string;     // excluded from strategy — live countdown, not stable
  rewards: string[];     // aria-label strings from reward icons
  description: string;
  eligible: boolean;
}

export interface StrategyContext {
  taskboard?: unknown;
  stackedOffers?: unknown;
  energy?: unknown;       // plain current-energy number
  energyMax?: unknown;    // plain max-energy number (1000 base + VIP bonus); default 1000
  inventory?: unknown;    // {itemId: quantity}
  skills?: unknown;       // {skillName: {level, totalExp}} or {skillName: number}
  levels?: unknown;       // legacy alias for skills
  playerId?: string;      // GPlayerCore.mid — needed for marketplace calls
  authToken?: string;     // game session token (kept for backend fallback only)
  // Pre-fetched by the extension and sent in the /ask payload.
  // Keys are itemIds; values are the lowest listing price and available quantity.
  marketPrices?: Record<string, { lowestPrice: number; quantity: number }>;
}

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

export interface ImmediateWin {
  type: "taskboard" | "stacked_offer";
  label: string;
  rewards: string[];
  detail: string;
}

export interface NearTermOpportunity {
  type: "craftable" | "gatherable_or_buyable";
  itemName: string;
  tier: string;
  quantityNeeded: number;
  // craftable fields:
  energyCostPerCraft?: number;
  craftsNeeded?: number;
  totalEnergyCost?: number;
  xpPerCraft?: number;
  xpSkill?: string;
  ingredients?: Array<{ itemName: string; quantity: number }>;
  outputQuantity?: number;
  requiredSkill?: string | null;
  requiredLevel?: number;
  canCraftWithCurrentSkills?: boolean;
  gatheringEnergy?: number; // total energy per harvest cycle for crops (plantEnergy + harvestNRG)
  detail: string;
}

export interface BestActionsResult {
  immediateWins: ImmediateWin[];
  nearTermOpportunities: NearTermOpportunity[];
  notes: string[];
}

// ---------------------------------------------------------------------------
// Shadow-price constant — for reward-vs-cost comparison only.
// 500k Coins ≈ 30 Pixels (conservative one-way rate; Coins→Pixels direction
// does not exist — this rate is used only to express Pixel rewards in a common
// Coin-equivalent unit for comparison, never to suggest conversion).
// ---------------------------------------------------------------------------
const PIXELS_PER_COIN_RATE = 30 / 500_000;

// ---------------------------------------------------------------------------
// Skill display helpers — catalog internal keys → player-facing names
// ---------------------------------------------------------------------------

const STRATEGY_SKILL_DISPLAY: Record<string, string> = {
  exploration:   "Exploration",
  petcare:       "Animal Care",
  farming:       "Farming",
  mining:        "Mining",
  forestry:      "Forestry",
  crafting:      "Crafting",
  woodwork:      "Woodwork",
  cooking:       "Cooking",
  metalworking:  "Metalworking",
  stoneshaping:  "Stoneshaping",
  business:      "Business",
};

// catalog "petcare" → player skill key "animalcare"
const SKILL_KEY_ALIASES: Record<string, string> = { petcare: "animalcare" };

function normalizeSkillKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

function displaySkill(catalogSkill: string | null): string {
  if (!catalogSkill) return "unknown skill";
  return STRATEGY_SKILL_DISPLAY[catalogSkill]
    ?? (catalogSkill.charAt(0).toUpperCase() + catalogSkill.slice(1));
}

function playerLevelForSkill(
  catalogSkill: string | null,
  playerSkills: Record<string, number>,
): number {
  if (!catalogSkill) return 0;
  const normalized = normalizeSkillKey(catalogSkill);
  const aliased    = SKILL_KEY_ALIASES[normalized] ?? normalized;
  for (const [sk, level] of Object.entries(playerSkills)) {
    const norm = normalizeSkillKey(sk);
    if (norm === normalized || norm === aliased) return level;
  }
  return 0;
}

// ---------------------------------------------------------------------------

function parseKValue(s: string): number {
  const m = s.replace(/,/g, "").trim().match(/^(\d+(?:\.\d+)?)([Kk]?)$/);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return isNaN(n) ? 0 : m[2] ? Math.round(n * 1000) : Math.round(n);
}

function parseRewardString(s: string): { coins: number; pixels: number } {
  const coinMatch  = s.match(/([0-9,]+)\s*coins?/i);
  const pixelMatch = s.match(/([0-9,]+)\s*pixels?/i);
  return {
    coins:  coinMatch  ? parseInt(coinMatch[1].replace(/,/g,  ""), 10) : 0,
    pixels: pixelMatch ? parseInt(pixelMatch[1].replace(/,/g, ""), 10) : 0,
  };
}

// costs[] format: [goldenIconCount, coinReward] e.g. ["359", "14K"]
// Falls back to parseRewardString for labelled strings like "14,000 coins".
function rewardCoinEquivalent(costs: string[]): number | null {
  if (costs.length === 0) return null;
  // If costs[1] exists it's the coin reward (K-formatted); costs[0] is golden icon count
  if (costs.length >= 2) {
    const coins = parseKValue(costs[1]);
    if (coins > 0) return coins;
  }
  // Fallback: try labelled strings
  let totalCoins = 0, totalPixels = 0;
  for (const r of costs) {
    const { coins, pixels } = parseRewardString(r);
    totalCoins  += coins;
    totalPixels += pixels;
  }
  if (totalCoins === 0 && totalPixels === 0) return null;
  return totalCoins + totalPixels / PIXELS_PER_COIN_RATE;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function safeArray<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function extractSkillLevels(skills: unknown): Record<string, number> {
  if (!skills || typeof skills !== "object") return {};
  const result: Record<string, number> = {};
  for (const [skill, val] of Object.entries(skills as Record<string, unknown>)) {
    if (typeof val === "number") {
      result[skill] = val;
    } else if (val && typeof val === "object") {
      const v = val as Record<string, unknown>;
      const lvl =
        typeof v.level === "number" ? v.level :
        typeof v.current === "number" ? v.current : null;
      if (lvl !== null) result[skill] = lvl;
    }
  }
  return result;
}

function extractEnergy(energy: unknown): number | null {
  if (typeof energy === "number" && Number.isFinite(energy)) return energy;
  if (energy && typeof energy === "object") {
    const e = energy as Record<string, unknown>;
    const cur = e.current ?? e.level;
    if (typeof cur === "number" && Number.isFinite(cur)) return cur;
  }
  return null;
}

// ---------------------------------------------------------------------------
// findRecipeMeta — extract top-level recipe metadata from the achievements catalog.
// Used only as a fallback for items that have no catalog row.
// ---------------------------------------------------------------------------

interface RecipeMeta {
  energyCost:    number;
  xpPerCraft:    number;
  xpSkill:       string;
  requiredSkill: string | null;
  requiredLevel: number;
  outputQuantity: number;
}

function findRecipeMeta(
  itemId: string,
  allAchievements: Record<string, any>,
): RecipeMeta | null {
  let craftable: any = allAchievements[itemId]?.craftable;
  if (!craftable) {
    for (const a of Object.values(allAchievements)) {
      const resultItems: any[] = (a as any)?.craftable?.result?.items ?? [];
      if (resultItems.some((ri: any) => ri?.id === itemId)) {
        craftable = (a as any).craftable;
        break;
      }
    }
  }
  if (!craftable) return null;

  const resultItems: any[] = craftable.result?.items ?? [];
  const outputQuantity = resultItems.reduce((sum: number, ri: any) => {
    if (ri?.id === itemId) return sum + (typeof ri?.quantity === "number" ? ri.quantity : 1);
    return sum;
  }, 0) || 1;

  const exps: any[] = craftable.result?.exps ?? [];
  const xpPerCraft = exps.reduce(
    (sum: number, e: any) => sum + (typeof e?.exp === "number" ? e.exp : 0), 0,
  );
  const xpSkill: string = exps[0]?.type ?? "";

  return {
    energyCost:    typeof craftable.energy === "number" ? craftable.energy : 0,
    xpPerCraft,
    xpSkill,
    requiredSkill: typeof craftable.requiredSkill === "string" ? craftable.requiredSkill : null,
    requiredLevel: typeof craftable.requiredLevel === "number" ? craftable.requiredLevel : 0,
    outputQuantity,
  };
}

function extractInventory(inventory: unknown): Record<string, number> {
  if (!inventory || typeof inventory !== "object") return {};
  const result: Record<string, number> = {};
  for (const [id, qty] of Object.entries(inventory as Record<string, unknown>)) {
    if (typeof qty === "number") result[id] = qty;
  }
  return result;
}

// ---------------------------------------------------------------------------
// computeBestActions
// ---------------------------------------------------------------------------

export async function computeBestActions(
  ctx: StrategyContext,
): Promise<BestActionsResult> {
  const taskboard     = safeArray<TaskboardItem>(ctx.taskboard);
  const offers        = safeArray<StackedOffer>(ctx.stackedOffers);
  const skillLevels   = extractSkillLevels(ctx.skills ?? ctx.levels);
  const currentEnergy = extractEnergy(ctx.energy);
  const maxEnergy     = extractEnergy(ctx.energyMax) ?? 1000; // default to base cap
  const inventory     = extractInventory(ctx.inventory);

  const immediateWins: ImmediateWin[]             = [];
  const nearTermOpportunities: NearTermOpportunity[] = [];
  const notes: string[] = [];
  const priceOpts =
    ctx.playerId ? { pid: ctx.playerId, authToken: ctx.authToken ?? null } : null;
  // Pre-fetched prices from the extension take priority over backend fetching.
  const prefetchedPrices: Map<string, MarketListing> = new Map(
    Object.entries(ctx.marketPrices ?? {}).map(([id, v]) => [id, v as MarketListing]),
  );

  // ---- 1. Immediate wins ---------------------------------------------------
  // Any taskboard order ready to deliver, or any stacked offer already eligible.

  for (const item of taskboard) {
    if (!item.canDeliverNow) continue;
    // Format costs[]: costs[0]=golden icon count, costs[1]=coin reward (K-formatted)
    let rewardStr: string;
    if (item.costs.length >= 2) {
      const coins = parseKValue(item.costs[1]);
      const goldenIcon = parseKValue(item.costs[0]);
      rewardStr = `${coins.toLocaleString("en")} coins + ${goldenIcon} golden icon reward`;
    } else {
      rewardStr = item.costs.length > 0 ? item.costs.join(", ") : "reward not shown";
    }
    const rewardCoinEq = rewardCoinEquivalent(item.costs);
    const rewardNote = rewardCoinEq !== null
      ? ` (~${Math.round(rewardCoinEq).toLocaleString("en")} Coin-equivalent)`
      : "";
    immediateWins.push({
      type:    "taskboard",
      label:   `${item.itemName}${item.tier ? ` (${item.tier})` : ""}`,
      rewards: item.costs,
      detail:  `Taskboard delivery ready — ${item.quantityNeeded}x needed, reward: ${rewardStr}${rewardNote}`,
    });
  }

  for (const offer of offers) {
    if (!offer.eligible) continue;
    const rewardStr =
      offer.rewards.length > 0 ? offer.rewards.join(", ") : "reward not shown";
    immediateWins.push({
      type:    "stacked_offer",
      label:   offer.requirementText || offer.description || "Stacked offer",
      rewards: offer.rewards,
      detail:  `Stacked offer eligible — ${offer.requirementText}. Rewards: ${rewardStr}`,
    });
  }

  // ---- 2. Near-term opportunities: undelivered taskboard items -------------
  // Catalog-first routing: category determines gathering vs crafting path.
  // Skills and levels come from catalog only — never invented.

  const undeliverable = taskboard.filter(
    (item) => !item.canDeliverNow && !item.isVipLocked,
  );

  if (undeliverable.length > 0) {
    // Ensure catalog is current before routing.
    try {
      await rebuildCatalogIfNeeded(false);
    } catch {
      notes.push("Catalog unavailable — skill/level data may be incomplete.");
    }

    let allItems: Record<string, any> = {};
    let allAchievements: Record<string, any> = {};
    let nameMap: Record<string, string> = {};
    try {
      [allItems, allAchievements, nameMap] = await Promise.all([
        fetchItems(), fetchAchievements(), fetchLocaleNameMap(),
      ]);
    } catch {
      notes.push("Game library unavailable — could not look up crafting recipes.");
    }
    const harvestMap = buildHarvestMap(allItems, nameMap);

    // Pre-resolve item IDs, catalog rows, and leaf ingredient IDs for price batching.
    interface ItemResolved {
      itemId:          string | null;
      catalogRow:      CatalogRow | undefined;
      inventoryQty:    number;
      stillNeeded:     number;
      meta:            RecipeMeta | null; // only set for crafted/unknown; null for gathered
      leafIngredients: Array<{ itemId: string | null; itemName: string; quantity: number }>;
    }
    const resolved: ItemResolved[] = undeliverable.map((item) => {
      const nameResult = resolveItemName(item.itemName, nameMap, allItems, allAchievements);
      let itemId: string | null = nameResult.kind === "found" ? nameResult.itemId : null;

      if (!itemId) {
        const reason = nameResult.kind === "candidates"
          ? `ambiguous (${(nameResult as any).items.map((c: any) => c.displayName).join(", ")})`
          : "not found in locale map";
        console.warn(`[computeBestActions] taskboard item "${item.itemName}" ${reason}`);
      }

      // Catalog lookup — primary routing source.
      let catalogRow: CatalogRow | undefined = itemId ? getCatalogRow(itemId) : undefined;

      // Fuzzy fallback when exact ID missed the catalog.
      if (!catalogRow && item.itemName) {
        const fuzzy = fuzzyResolveName(item.itemName, 2);
        if (fuzzy) {
          const fuzzyCatalog = getCatalogRow(fuzzy.itemId);
          if (fuzzyCatalog) {
            catalogRow = fuzzyCatalog;
            if (!itemId) itemId = fuzzy.itemId;
          }
        }
      }

      // Call findRecipeMeta only for crafted items or when catalog has no entry —
      // never for gathered/crop/retired/seed items (avoids wrong recipe lookup).
      const catalogCategory = catalogRow?.category ?? null;
      const needsMeta =
        catalogCategory === "crafted" ||
        catalogCategory === null; // no catalog entry — try recipe as fallback
      const meta = (needsMeta && itemId)
        ? findRecipeMeta(itemId, allAchievements)
        : null;

      const inventoryQty = itemId ? (inventory[itemId] ?? 0) : 0;
      const stillNeeded  = Math.max(0, item.quantityNeeded - inventoryQty);

      const leafMap = (meta && itemId)
        ? resolveCraftableRecursive(itemId, stillNeeded, allItems, allAchievements, harvestMap, new Set(), nameMap)
        : new Map<string, any>();
      const leafIngredients = [...leafMap.values()].map((leaf) => ({
        itemId:   leaf.id,
        itemName: nameMap[leaf.id] ?? leaf.name as string,
        quantity: leaf.totalQuantity as number,
      }));

      return { itemId, catalogRow, inventoryQty, stillNeeded, meta, leafIngredients };
    });

    // Batch price lookup — all delivery item IDs + all leaf ingredient IDs.
    const allPriceIds = new Set<string>();
    for (const r of resolved) {
      if (r.itemId) allPriceIds.add(r.itemId);
      for (const leaf of r.leafIngredients) {
        if (leaf.itemId) allPriceIds.add(leaf.itemId);
      }
    }

    const prices: Map<string, MarketListing> = new Map(prefetchedPrices);
    const missingIds = [...allPriceIds].filter((id) => !prices.has(id));
    if (priceOpts && missingIds.length > 0) {
      const backendPrices = await fetchMarketPrices(missingIds, priceOpts).catch(() => new Map());
      for (const [id, listing] of backendPrices) prices.set(id, listing);
    }
    // DB fallback: use stored market_prices for items still without a price
    for (const id of [...allPriceIds].filter(id => !prices.has(id))) {
      const dbRow = getMarketPrice(id);
      if (dbRow) prices.set(id, { lowestPrice: dbRow.min_price, quantity: dbRow.volume });
    }

    if (prices.size === 0 && allPriceIds.size > 0) {
      notes.push("Marketplace prices unavailable — showing energy/XP costs only.");
    }

    for (let idx = 0; idx < undeliverable.length; idx++) {
      const item = undeliverable[idx];
      const { itemId, catalogRow, inventoryQty, stillNeeded, meta, leafIngredients } = resolved[idx];
      const category = catalogRow?.category ?? null;

      const rewardCoinEq = rewardCoinEquivalent(item.costs);
      const rewardNote = rewardCoinEq !== null
        ? `reward ~${Math.round(rewardCoinEq).toLocaleString("en")} Coin-equivalent` +
          ` (for reference — Coins and Pixels are separate currencies)`
        : null;

      // ---- RETIRED: not obtainable right now ----
      if (category === "retired") {
        const parts: string[] = [`Need ${item.quantityNeeded}x for taskboard`];
        if (inventoryQty > 0) parts.push(`have ${inventoryQty} in inventory — ${stillNeeded} more needed`);
        parts.push("not obtainable right now — this is a retired or event item");
        const buyPrice = itemId ? prices.get(itemId) : undefined;
        if (buyPrice) {
          const buyCost = buyPrice.lowestPrice * stillNeeded;
          parts.push(
            `market price ~${buyPrice.lowestPrice.toLocaleString("en")} coins each` +
            ` × ${stillNeeded} = ~${buyCost.toLocaleString("en")} coins` +
            ` (${buyPrice.quantity} listed) — may be available from other players`,
          );
        } else {
          parts.push("check marketplace — may be available from other players' stock");
        }
        if (rewardNote) parts.push(rewardNote);
        nearTermOpportunities.push({
          type: "gatherable_or_buyable",
          itemName: item.itemName,
          tier: item.tier,
          quantityNeeded: item.quantityNeeded,
          detail: parts.join("; "),
        });
        continue;
      }

      // ---- SEED: bought at Buck's shop ----
      if (category === "seed") {
        const farmingLevel = catalogRow?.level_required ?? null;
        const cropsInto    = catalogRow?.seed_name ?? "unknown crop";
        const parts: string[] = [`Need ${item.quantityNeeded}x for taskboard`];
        if (inventoryQty > 0) parts.push(`have ${inventoryQty} in inventory — ${stillNeeded} more needed`);
        parts.push(`${item.itemName} is a seed — bought at Buck's shop, plants into ${cropsInto}`);
        if (farmingLevel !== null && farmingLevel > 0) {
          const playerFarming = playerLevelForSkill("farming", skillLevels);
          const farmOk = playerFarming >= farmingLevel
            ? ` (player Farming lv ${playerFarming} — OK)`
            : ` (player Farming lv ${playerFarming} — cannot plant yet)`;
          parts.push(`requires Farming level ${farmingLevel}${farmOk}`);
        }
        const buyPrice = itemId ? prices.get(itemId) : undefined;
        if (buyPrice) {
          const buyCost = buyPrice.lowestPrice * stillNeeded;
          parts.push(
            `market price ~${buyPrice.lowestPrice.toLocaleString("en")} coins each` +
            ` × ${stillNeeded} = ~${buyCost.toLocaleString("en")} coins (${buyPrice.quantity} listed)`,
          );
        } else {
          parts.push("price unknown — check Buck's shop or marketplace");
        }
        if (rewardNote) parts.push(rewardNote);
        nearTermOpportunities.push({
          type: "gatherable_or_buyable",
          itemName: item.itemName,
          tier: item.tier,
          quantityNeeded: item.quantityNeeded,
          detail: parts.join("; "),
        });
        continue;
      }

      // ---- GATHERED: mined / chopped / fished / animal product ----
      if (category === "gathered") {
        const catalogSkill  = catalogRow?.skill ?? null;
        const catalogLevel  = catalogRow?.level_required ?? null;
        const industry      = catalogRow?.industry ?? null;
        const sourceLabel   = catalogRow?.recipe_station ?? null; // animal product source entity
        const toolType      = catalogRow?.tool_type ?? null;
        const toolTier      = catalogRow?.tool_min_tier ?? null;

        // Sanity: never accept a level > 100 from catalog
        if (catalogLevel !== null && catalogLevel > 100) {
          console.warn(`[computeBestActions] dropping "${item.itemName}" — catalog level ${catalogLevel} > 100`);
          notes.push(`${item.itemName}: level sanity check failed (${catalogLevel} > 100) — skipped.`);
          continue;
        }

        const parts: string[] = [`Need ${item.quantityNeeded}x for taskboard`];
        if (inventoryQty > 0) parts.push(`have ${inventoryQty} in inventory — ${stillNeeded} more needed`);

        let obtainStr = "obtained by gathering";
        if (industry === "mine")           obtainStr = "obtained by mining";
        else if (industry === "forestry")  obtainStr = "obtained by chopping trees";
        else if (industry === "fishing")   obtainStr = "caught by fishing (Exploration skill)";
        else if (industry === "animal product") {
          obtainStr = sourceLabel
            ? `obtained from ${sourceLabel} (placed on your land)`
            : "obtained from an animal (placed on your land)";
        }

        let levelStr = "";
        if (catalogSkill && catalogLevel !== null && catalogLevel > 0) {
          const playerLv = playerLevelForSkill(catalogSkill, skillLevels);
          const canGather = playerLv >= catalogLevel;
          levelStr = ` — requires ${displaySkill(catalogSkill)} level ${catalogLevel}` +
            ` (player lv ${playerLv} — ${canGather ? "OK" : "cannot gather yet"})`;
        } else if (catalogSkill) {
          levelStr = ` — skill: ${displaySkill(catalogSkill)}`;
        }

        parts.push(`${item.itemName} is a gathered item: ${obtainStr}${levelStr}`);
        parts.push("gathering energy not known");

        if (toolType) {
          const toolStr = toolTier ? `${toolType} (min tier ${toolTier})` : toolType;
          parts.push(`tool required: ${toolStr}`);
        }

        const buyPrice = itemId ? prices.get(itemId) : undefined;
        if (buyPrice) {
          const buyCost = buyPrice.lowestPrice * stillNeeded;
          parts.push(
            `market price ~${buyPrice.lowestPrice.toLocaleString("en")} coins each` +
            ` × ${stillNeeded} = ~${buyCost.toLocaleString("en")} coins (${buyPrice.quantity} listed)`,
          );
          if (rewardCoinEq !== null) {
            const verdict = buyCost < rewardCoinEq ? "reward exceeds buy cost" : "buy cost exceeds reward";
            parts.push(
              `reward ~${Math.round(rewardCoinEq).toLocaleString("en")} Coin-equivalent;` +
              ` buy cost ~${buyCost.toLocaleString("en")} coins — ${verdict}` +
              ` (Coins and Pixels are separate currencies)`,
            );
          }
        } else {
          parts.push(
            itemId
              ? "price unknown — gather or check marketplace"
              : "no item ID resolved — gather or check marketplace",
          );
          if (rewardNote) parts.push(rewardNote);
        }

        nearTermOpportunities.push({
          type:           "gatherable_or_buyable",
          itemName:       item.itemName,
          tier:           item.tier,
          quantityNeeded: item.quantityNeeded,
          detail:         parts.join("; "),
        });
        continue;
      }

      // ---- CROP: grown from seed ----
      if (category === "crop") {
        const plantEnergy   = catalogRow?.plant_energy ?? null;
        const harvestEnergy = catalogRow?.harvest_energy ?? null;
        const farmingLevel  = catalogRow?.level_required ?? null;

        const cropGatheringEnergy: number | null =
          plantEnergy !== null && harvestEnergy !== null
            ? plantEnergy + harvestEnergy
            : null;

        const parts: string[] = [`Need ${item.quantityNeeded}x for taskboard`];
        if (inventoryQty > 0) parts.push(`have ${inventoryQty} in inventory — ${stillNeeded} more needed`);

        parts.push(`${item.itemName} is a crop (grown from seed)`);

        if (farmingLevel !== null && farmingLevel > 0) {
          const playerFarming = playerLevelForSkill("farming", skillLevels);
          const farmOk = playerFarming >= farmingLevel
            ? ` (player Farming lv ${playerFarming} — OK)`
            : ` (player Farming lv ${playerFarming} — cannot farm yet)`;
          parts.push(`requires Farming level ${farmingLevel}${farmOk}`);
        }

        if (cropGatheringEnergy !== null) {
          parts.push(
            `farming: ${cropGatheringEnergy} energy per harvest cycle` +
            ` (${plantEnergy} plant + ${harvestEnergy} harvest)`,
          );
        } else {
          parts.push("farming energy: not known");
        }

        const buyPrice = itemId ? prices.get(itemId) : undefined;
        if (buyPrice) {
          const buyCost = buyPrice.lowestPrice * stillNeeded;
          parts.push(
            `market price ~${buyPrice.lowestPrice.toLocaleString("en")} coins each` +
            ` × ${stillNeeded} = ~${buyCost.toLocaleString("en")} coins (${buyPrice.quantity} listed)`,
          );
          if (rewardCoinEq !== null) {
            const verdict = buyCost < rewardCoinEq ? "reward exceeds buy cost" : "buy cost exceeds reward";
            parts.push(
              `reward ~${Math.round(rewardCoinEq).toLocaleString("en")} Coin-equivalent;` +
              ` buy cost ~${buyCost.toLocaleString("en")} coins — ${verdict}` +
              ` (Coins and Pixels are separate currencies)`,
            );
          }
        } else {
          parts.push(
            itemId
              ? "price unknown — farm or check marketplace"
              : "no item ID resolved — farm or check marketplace",
          );
          if (rewardNote) parts.push(rewardNote);
        }

        nearTermOpportunities.push({
          type:           "gatherable_or_buyable",
          itemName:       item.itemName,
          tier:           item.tier,
          quantityNeeded: item.quantityNeeded,
          ...(cropGatheringEnergy !== null ? { gatheringEnergy: cropGatheringEnergy } : {}),
          detail:         parts.join("; "),
        });
        continue;
      }

      // ---- CRAFTED (or no catalog row — meta as fallback) ----
      // When catalog says "crafted", prefer catalog values; fall back to meta where null.
      // When no catalog row, use meta entirely (legacy fallback for uncatalogued items).

      if (category !== "crafted" && category !== null) {
        // Unrecognised catalog category — treat as gather/buy.
        const parts: string[] = [
          `Need ${item.quantityNeeded}x for taskboard — category "${category}" not handled`,
        ];
        if (rewardNote) parts.push(rewardNote);
        nearTermOpportunities.push({
          type: "gatherable_or_buyable",
          itemName: item.itemName,
          tier: item.tier,
          quantityNeeded: item.quantityNeeded,
          detail: parts.join("; "),
        });
        continue;
      }

      // Use catalog values when available; fall back to meta otherwise.
      const craftEnergy    = catalogRow?.craft_energy  ?? meta?.energyCost   ?? null;
      const craftOutputQty = catalogRow?.recipe_output_qty ?? meta?.outputQuantity ?? 1;
      const craftXp        = catalogRow?.craft_xp      ?? meta?.xpPerCraft   ?? 0;
      const craftSkill     = catalogRow?.skill          ?? meta?.requiredSkill ?? null;
      const craftLevel     = catalogRow?.level_required ?? meta?.requiredLevel ?? 0;
      const craftXpSkill   = catalogRow?.skill          ?? meta?.xpSkill      ?? "";

      if (craftEnergy === null && !meta) {
        // No recipe and no catalog entry — gather/buy fallback.
        const parts: string[] = [
          `Need ${item.quantityNeeded}x for taskboard — no crafting recipe found`,
        ];
        if (inventoryQty > 0) parts.push(`have ${inventoryQty} in inventory — ${stillNeeded} more needed`);

        // Check if it's actually a crop by scanning seeds in the library.
        let cropGatheringEnergy: number | null = null;
        if (itemId) {
          for (const seed of Object.values(allItems)) {
            if ((seed as any)?.onUse?.plant?.fruit === itemId) {
              const plant = (seed as any).onUse.plant;
              const harvestNRG = typeof plant.harvestNRG === "number" ? plant.harvestNRG : null;
              const rawPlant   = (seed as any)?.onUse?.energy?.value;
              const plantE     = typeof rawPlant === "number" ? Math.abs(rawPlant) : null;
              if (harvestNRG !== null && plantE !== null) cropGatheringEnergy = plantE + harvestNRG;
              break;
            }
          }
        }
        if (cropGatheringEnergy !== null) {
          parts.push(`farming: ${cropGatheringEnergy} energy per harvest cycle (plant + harvest)`);
        }

        const buyPrice = itemId ? prices.get(itemId) : undefined;
        if (buyPrice) {
          const buyCost = buyPrice.lowestPrice * stillNeeded;
          parts.push(
            `market price ~${buyPrice.lowestPrice.toLocaleString("en")} coins each` +
            ` × ${stillNeeded} = ~${buyCost.toLocaleString("en")} coins (${buyPrice.quantity} listed)`,
          );
          if (rewardCoinEq !== null) {
            const verdict = buyCost < rewardCoinEq ? "reward exceeds buy cost" : "buy cost exceeds reward";
            parts.push(
              `reward ~${Math.round(rewardCoinEq).toLocaleString("en")} Coin-equivalent;` +
              ` buy cost ~${buyCost.toLocaleString("en")} coins — ${verdict}` +
              ` (Coins and Pixels are separate currencies)`,
            );
          }
        } else {
          parts.push(
            itemId
              ? "price unknown — must be gathered or purchased from the marketplace"
              : "no item ID resolved — must be gathered or purchased from the marketplace",
          );
          if (rewardNote) parts.push(rewardNote);
        }

        nearTermOpportunities.push({
          type:           "gatherable_or_buyable",
          itemName:       item.itemName,
          tier:           item.tier,
          quantityNeeded: item.quantityNeeded,
          ...(cropGatheringEnergy !== null ? { gatheringEnergy: cropGatheringEnergy } : {}),
          detail:         parts.join("; "),
        });
        continue;
      }

      // Compute crafting costs.
      const craftsNeeded  = (craftOutputQty ?? 1) > 0
        ? Math.ceil(stillNeeded / (craftOutputQty ?? 1))
        : stillNeeded;
      const totalEnergy   = craftsNeeded * (craftEnergy ?? 0);

      // Sanity checks — drop lines with clearly garbage values.
      if (craftLevel > 100) {
        console.warn(`[computeBestActions] dropping "${item.itemName}" — level ${craftLevel} > 100`);
        notes.push(`${item.itemName}: level sanity check failed (level ${craftLevel} > 100) — skipped.`);
        continue;
      }
      if (totalEnergy > 50_000) {
        console.warn(`[computeBestActions] dropping "${item.itemName}" — totalEnergy ${totalEnergy} > 50000`);
        notes.push(`${item.itemName}: energy sanity check failed (${totalEnergy.toLocaleString("en")} energy > 50,000) — skipped.`);
        continue;
      }

      const playerSkillLevel = craftSkill ? playerLevelForSkill(craftSkill, skillLevels) : 0;
      const canCraft = craftLevel === 0 || playerSkillLevel >= craftLevel;

      // Ingredient string — include per-unit price when known.
      const ingStr =
        leafIngredients.length > 0
          ? leafIngredients.map((leaf) => {
              const price = leaf.itemId ? prices.get(leaf.itemId) : undefined;
              const priceTag = price
                ? ` @${price.lowestPrice.toLocaleString("en")} coins ea`
                : " (price unknown)";
              return `${leaf.quantity}x ${leaf.itemName}${priceTag}`;
            }).join(", ")
          : "no ingredients";

      // Total ingredient buy cost (only when ALL leaf prices are known).
      let ingredientBuyCost: number | null = null;
      if (leafIngredients.length > 0) {
        let running = 0, allKnown = true;
        for (const leaf of leafIngredients) {
          const price = leaf.itemId ? prices.get(leaf.itemId) : undefined;
          if (price) { running += price.lowestPrice * leaf.quantity; }
          else        { allKnown = false; }
        }
        if (allKnown && running > 0) ingredientBuyCost = running;
      }

      const parts: string[] = [`Need ${item.quantityNeeded}x for taskboard`];

      if (inventoryQty > 0) {
        parts.push(`have ${inventoryQty} in inventory — ${stillNeeded} more needed`);
      }

      const skillLabel = craftSkill ? displaySkill(craftSkill) : null;

      parts.push(
        `recipe: ${craftEnergy ?? "?"} energy per craft, yields ${craftOutputQty ?? 1}x;` +
        ` raw materials needed: ${ingStr}`,
      );

      if (craftXp > 0 && craftXpSkill) {
        parts.push(`${craftXp} ${displaySkill(craftXpSkill)} XP per craft`);
      }

      parts.push(`crafts needed: ${craftsNeeded}, total energy: ${totalEnergy}`);

      if (!canCraft) {
        parts.push(
          `CANNOT CRAFT — requires ${skillLabel ?? craftSkill} level ${craftLevel}` +
          ` (player has level ${playerSkillLevel}) — must buy or gather instead`,
        );
        if (itemId) {
          const price = prices.get(itemId);
          if (price) {
            parts.push(
              `market price ~${price.lowestPrice.toLocaleString("en")} coins each` +
              ` × ${stillNeeded} = ~${(price.lowestPrice * stillNeeded).toLocaleString("en")} coins` +
              ` (${price.quantity} listed)`,
            );
          }
        }
      } else if (craftSkill && craftLevel > 0) {
        parts.push(
          `requires ${skillLabel ?? craftSkill} level ${craftLevel}` +
          ` (player has level ${playerSkillLevel} — OK)`,
        );
      }

      // Energy gate: totalEnergy vs maxEnergy.
      let energyDrinkCost = 0;
      if (canCraft) {
        if (totalEnergy > maxEnergy) {
          const daysNeeded = Math.ceil(totalEnergy / maxEnergy);
          parts.push(
            `requires ${totalEnergy.toLocaleString("en")} energy total — exceeds max energy capacity (${maxEnergy})` +
            ` — not doable in one day; buy it or spread over ${daysNeeded} days`,
          );
        } else if (currentEnergy !== null) {
          if (currentEnergy >= totalEnergy) {
            parts.push(`current energy (${currentEnergy}) is sufficient`);
          } else {
            const deficit = totalEnergy - currentEnergy;
            energyDrinkCost = Math.ceil(deficit / 100) * 5_000;
            parts.push(
              `current energy (${currentEnergy}) insufficient —` +
              ` need ${deficit} more` +
              ` (~${energyDrinkCost.toLocaleString("en")} coins via energy drinks at 5,000/100 energy)`,
            );
          }
        }
      }

      // Cheapest-path recommendation.
      if (canCraft && stillNeeded === 0) {
        parts.push(
          "RECOMMENDED: use from storage — already have enough in inventory (zero cost)",
        );
      } else if (canCraft && stillNeeded > 0) {
        const buyPrice = itemId ? prices.get(itemId) : undefined;
        const craftTotalCost = ingredientBuyCost !== null ? ingredientBuyCost + energyDrinkCost : null;
        const buyTotalCost   = buyPrice ? buyPrice.lowestPrice * stillNeeded : null;

        if (craftTotalCost !== null && buyTotalCost !== null) {
          if (craftTotalCost <= buyTotalCost) {
            const saving = buyTotalCost - craftTotalCost;
            parts.push(
              `RECOMMENDED: craft (saves ~${saving.toLocaleString("en")} coins vs buying` +
              ` — craft ~${craftTotalCost.toLocaleString("en")} coins, buy ~${buyTotalCost.toLocaleString("en")} coins)`,
            );
          } else {
            const saving = craftTotalCost - buyTotalCost;
            parts.push(
              `RECOMMENDED: buy (saves ~${saving.toLocaleString("en")} coins vs crafting` +
              ` — buy ~${buyTotalCost.toLocaleString("en")} coins, craft ~${craftTotalCost.toLocaleString("en")} coins)`,
            );
          }
        } else if (craftTotalCost !== null) {
          parts.push(
            `craft cost ~${craftTotalCost.toLocaleString("en")} coins` +
            ` (buy price unknown — cannot compare)`,
          );
        } else if (buyTotalCost !== null) {
          parts.push(
            `buy cost ~${buyTotalCost.toLocaleString("en")} coins` +
            ` (ingredient prices unknown — cannot compare craft cost)`,
          );
        }
      }

      // Worth-it: reward vs ingredient buy cost.
      if (rewardCoinEq !== null) {
        if (ingredientBuyCost !== null && canCraft) {
          const verdict =
            ingredientBuyCost < rewardCoinEq ? "reward exceeds ingredient cost" : "ingredient cost exceeds reward";
          parts.push(
            `reward ~${Math.round(rewardCoinEq).toLocaleString("en")} Coin-equivalent;` +
            ` ingredient buy cost ~${ingredientBuyCost.toLocaleString("en")} coins — ${verdict}` +
            ` (Coins and Pixels are separate currencies)`,
          );
        } else {
          parts.push(
            `reward ~${Math.round(rewardCoinEq).toLocaleString("en")} Coin-equivalent` +
            ` (for reference only — Coins and Pixels are separate currencies)`,
          );
        }
      }

      nearTermOpportunities.push({
        type:                      "craftable",
        itemName:                  item.itemName,
        tier:                      item.tier,
        quantityNeeded:            item.quantityNeeded,
        energyCostPerCraft:        craftEnergy ?? 0,
        craftsNeeded,
        totalEnergyCost:           totalEnergy,
        xpPerCraft:                craftXp,
        xpSkill:                   craftXpSkill ? displaySkill(craftXpSkill) : "",
        ingredients:               leafIngredients.map(({ itemName, quantity }) => ({ itemName, quantity })),
        outputQuantity:            craftOutputQty ?? 1,
        requiredSkill:             craftSkill ? displaySkill(craftSkill) : null,
        requiredLevel:             craftLevel,
        canCraftWithCurrentSkills: canCraft,
        detail:                    parts.join("; "),
      });
    }
  }

  // ---- VIP-locked items — note, don't analyze ----------------------------
  const vipLocked = taskboard.filter((item) => item.isVipLocked);
  if (vipLocked.length > 0) {
    notes.push(
      `${vipLocked.length} taskboard item(s) are VIP-locked and excluded from analysis:` +
      ` ${vipLocked.map((i) => i.itemName).join(", ")}.`,
    );
  }

  return { immediateWins, nearTermOpportunities, notes };
}
