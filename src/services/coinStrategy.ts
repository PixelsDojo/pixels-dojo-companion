import fs from "fs";
import path from "path";
import {
  listCatalogRows, getCatalogRow, getMarketPrice, getSalesRate,
  getTaskboardFrequency, getPriceTrend7d,
} from "../db/database";
import type { CatalogRow } from "../db/database";

const STATIC_DIR = path.join(__dirname, "../../static");

// ---------------------------------------------------------------------------
// Staples set — still used by marketData.ts priority-items endpoint for
// collector queue ordering. NOT used for ranking recommendations.
// ---------------------------------------------------------------------------

let _staplesSet: Set<string> | null = null;

export function getStaplesSet(): Set<string> {
  if (_staplesSet) return _staplesSet;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, "staples.json"), "utf8"));
    _staplesSet = new Set<string>(data.items ?? []);
  } catch {
    _staplesSet = new Set();
  }
  return _staplesSet;
}

export function invalidateStaplesCache(): void {
  _staplesSet = null;
}

// ---------------------------------------------------------------------------
// Non-tradeable — library items with trade.disableTrading === true
// ---------------------------------------------------------------------------

let _nonTradeableSet: Set<string> | null = null;

function getNonTradeableSet(): Set<string> {
  if (_nonTradeableSet) return _nonTradeableSet;
  try {
    const lib = JSON.parse(fs.readFileSync(path.join(STATIC_DIR, "library_10.5.json"), "utf8"));
    const items: Record<string, { trade?: { disableTrading?: boolean } }> = lib.items ?? {};
    _nonTradeableSet = new Set(
      Object.entries(items)
        .filter(([, v]) => v?.trade?.disableTrading === true)
        .map(([k]) => k),
    );
  } catch {
    _nonTradeableSet = new Set();
  }
  return _nonTradeableSet;
}

// ---------------------------------------------------------------------------
// Restricted industries
// ---------------------------------------------------------------------------

const RESTRICTED_INDUSTRIES = new Set(["quantum_recombinator"]);

// ---------------------------------------------------------------------------
// Probabilistic / chance-drop items — yields aren't guaranteed.
// Any item whose inputs include these is excluded from recommendations.
// "animal product" industry items are also excluded as inputs.
// ---------------------------------------------------------------------------

const CHANCE_DROP_ITEM_NAMES = new Set([
  "pearly swirl", "mirage egg", "sunbloom", "ashnut", "gloomshard",
  "rainbow feather", "golden egg", "moonpetal", "stardust shard",
]);

function isChanceInput(inputId: string): boolean {
  const row = getCatalogRow(inputId);
  if (!row) return false;
  // Animal products: non-deterministic yield
  if (row.industry === "animal product") return true;
  // Known rare drops by display name (lowercase match)
  const name = (row.display_name ?? "").toLowerCase();
  for (const cn of CHANCE_DROP_ITEM_NAMES) {
    if (name.includes(cn)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Ingredient usage — count how many recipes use each item as an input.
// ---------------------------------------------------------------------------

let _ingredientUsageCache: Map<string, number> | null = null;

export function computeIngredientUsage(): Map<string, number> {
  if (_ingredientUsageCache) return _ingredientUsageCache;
  const usage = new Map<string, number>();
  for (const row of listCatalogRows()) {
    const inputs = parseInputs(row);
    for (const inputId of Object.keys(inputs)) {
      usage.set(inputId, (usage.get(inputId) ?? 0) + 1);
    }
  }
  _ingredientUsageCache = usage;
  return usage;
}

export function invalidateIngredientCache(): void {
  _ingredientUsageCache = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeSkillKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

function playerLevelForSkill(catalogSkill: string | null, playerSkills: Record<string, number>): number {
  if (!catalogSkill) return 0;
  const key = normalizeSkillKey(catalogSkill);
  for (const [k, v] of Object.entries(playerSkills)) {
    if (normalizeSkillKey(k) === key) return v;
  }
  return 0;
}

function parseInputs(row: CatalogRow): Record<string, number> {
  if (!row.recipe_inputs) return {};
  try {
    const parsed = typeof row.recipe_inputs === "string"
      ? JSON.parse(row.recipe_inputs)
      : row.recipe_inputs;
    if (Array.isArray(parsed)) {
      const out: Record<string, number> = {};
      for (const entry of parsed) {
        if (entry && typeof entry.id === "string" && typeof entry.qty === "number") {
          out[entry.id] = entry.qty;
        }
      }
      return out;
    }
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as Record<string, number>;
    }
  } catch { /* malformed */ }
  return {};
}

// Depth-1 feasibility: every input must be market-buyable OR gatherable/crop,
// AND must not be a chance/animal drop.
function inputsAreFeasible(row: CatalogRow): { ok: boolean; reason?: string } {
  const inputs = parseInputs(row);
  for (const inputId of Object.keys(inputs)) {
    // Chance/animal inputs are excluded
    if (isChanceInput(inputId)) {
      const name = getCatalogRow(inputId)?.display_name ?? inputId;
      return { ok: false, reason: `chance/animal input: ${name}` };
    }
    if (getMarketPrice(inputId)) continue; // buyable on market
    const inputRow = getCatalogRow(inputId);
    if (!inputRow) return { ok: false, reason: `unknown ingredient: ${inputId}` };
    const cat = inputRow.category;
    if (cat === "gathered" || cat === "crop") continue;
    return { ok: false, reason: `input not buyable and not gatherable: ${inputRow.display_name ?? inputId}` };
  }
  return { ok: true };
}

// Cost (buying all ingredients at min_price) for one craft run.
function ingredientCost(row: CatalogRow): { cost: number; anyUnknown: boolean } {
  const inputs = parseInputs(row);
  let cost = 0;
  let anyUnknown = false;
  for (const [inputId, qty] of Object.entries(inputs)) {
    const price = getMarketPrice(inputId);
    if (!price) { anyUnknown = true; }
    else         { cost += price.min_price * qty; }
  }
  return { cost, anyUnknown };
}

// Effective sell price per unit: avg_sale_price when available, else avg_price.
function effectiveSellPrice(itemId: string): number | null {
  const p = getMarketPrice(itemId);
  if (!p) return null;
  return (p.avg_sale_price > 0) ? p.avg_sale_price : p.avg_price;
}

// Aggregate chest contents: Record<itemId, qty>
function aggregateChests(rawChests: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!rawChests || typeof rawChests !== "object") return out;
  type ChestEntry = { items?: Array<{ itemId: string; qty: number }> };
  for (const chest of Object.values(rawChests as Record<string, ChestEntry>)) {
    if (!Array.isArray(chest.items)) continue;
    for (const slot of chest.items) {
      if (typeof slot.itemId === "string" && typeof slot.qty === "number" && slot.qty > 0) {
        out[slot.itemId] = (out[slot.itemId] ?? 0) + slot.qty;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Target listing range
// ---------------------------------------------------------------------------

const TARGET_MIN = 100_000;
const TARGET_MAX = 200_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DemandSource = "purchasedQty" | "real" | "none";

export interface CoinStrategyOption {
  itemId:          string;
  itemName:        string;
  industry:        string;
  skill:           string;
  isStaple:        boolean;
  isOwnedStock:    boolean;
  ownedQty:        number;
  ownedValue:      number;
  profitPerUnit:   number;    // profit per output unit (crafted) or sell price (gathered)
  energyPerUnit:   number;    // energy per output unit
  salesPerDay:     number;
  trend:           "rising" | "steady" | "falling";
  priceTrend7d:    number | null;  // fractional change, e.g. 0.12 = +12%
  demandSource:    DemandSource;
  qtyForTarget:    number;    // qty needed to reach TARGET_MIN
  energyForTarget: number;    // energy needed for qtyForTarget
  fitsEnergy:      boolean;   // energyForTarget <= today's energy
  sellPrice:       number;    // effective sell price per unit
  inputCost:       number;    // input cost per output unit (0 for gathered)
  finalScore:      number;
  debug:           string;
}

export interface TaskboardCoinOption {
  itemId:    string;
  itemName:  string;
  reward:    number;
  inputCost: number | null;
  profit:    number | null;
  detail:    string;
}

export interface CoinStrategyResult {
  topCraftOptions:    CoinStrategyOption[];
  otherOpportunities: CoinStrategyOption[];
  topTaskboardOrders: TaskboardCoinOption[];
  codeAnswer:         string;
  knownItemNames:     Set<string>;
  missingMarketData:  string[];
  debug:              Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// computeCoinStrategy
// ---------------------------------------------------------------------------

export function computeCoinStrategy(params: {
  playerSkills:      Record<string, number>;
  energy:            number;
  energyMax:         number;
  taskboard?:        unknown[];
  playerInventory?:  Record<string, number>;
  chestContents?:    unknown; // raw storageChests object from ctx
}): CoinStrategyResult {
  const {
    playerSkills, energy, energyMax, taskboard = [],
    playerInventory = {}, chestContents,
  } = params;

  const nonTradeable = getNonTradeableSet();
  const staples      = getStaplesSet();
  const ingUsage     = computeIngredientUsage();
  const allRows      = listCatalogRows();
  const missingItems = new Set<string>();
  const filterLog:   Record<string, string> = {};

  const chests = aggregateChests(chestContents);
  const chestsOpened = Object.keys(chests).length > 0 ||
    (chestContents && typeof chestContents === "object" && Object.keys(chestContents as object).length > 0);

  const allCandidates: CoinStrategyOption[] = [];

  // ---------------------------------------------------------------------------
  // Pass 1 — owned stock: scan everything the player holds that has demand
  // ---------------------------------------------------------------------------

  // Build combined inventory (backpack + all chests)
  const combinedInv: Record<string, number> = { ...playerInventory };
  for (const [id, qty] of Object.entries(chests)) {
    combinedInv[id] = (combinedInv[id] ?? 0) + qty;
  }

  for (const [itemId, qty] of Object.entries(combinedInv)) {
    if (qty <= 0) continue;
    const priceRow = getMarketPrice(itemId);
    if (!priceRow) continue;
    if (nonTradeable.has(itemId)) continue;

    const sellPriceUnit = (priceRow.avg_sale_price > 0) ? priceRow.avg_sale_price : priceRow.avg_price;
    const ownedValue = qty * sellPriceUnit;
    if (ownedValue < TARGET_MIN) continue; // not worth leading with

    const sold7d = priceRow.sold_7d_est ?? 0;
    const { perDay: realPerDay, trend: realTrend } = getSalesRate(itemId);
    const salesPerDay = sold7d > 0 ? sold7d : realPerDay;
    const trend: "rising" | "steady" | "falling" = sold7d > 0 ? "steady" : realTrend;
    const demandSource: DemandSource = sold7d > 0 ? "purchasedQty" : realPerDay > 0 ? "real" : "none";
    if (demandSource === "none") continue; // no evidence it sells

    const priceTrend7d = getPriceTrend7d(itemId);
    const catalogR     = getCatalogRow(itemId);

    const option: CoinStrategyOption = {
      itemId,
      itemName:        catalogR?.display_name ?? itemId,
      industry:        catalogR?.industry ?? catalogR?.category ?? "owned",
      skill:           catalogR?.skill ?? "",
      isStaple:        staples.has(itemId),
      isOwnedStock:    true,
      ownedQty:        qty,
      ownedValue,
      profitPerUnit:   sellPriceUnit,
      energyPerUnit:   0,
      salesPerDay,
      trend,
      priceTrend7d,
      demandSource,
      qtyForTarget:    qty,          // already have them
      energyForTarget: 0,
      fitsEnergy:      true,
      sellPrice:       sellPriceUnit,
      inputCost:       0,
      finalScore:      ownedValue * (salesPerDay / 100),
      debug:           `owned=${qty} value=${Math.round(ownedValue)} perDay=${salesPerDay.toFixed(1)} trend7d=${priceTrend7d !== null ? (priceTrend7d * 100).toFixed(0) + "%" : "n/a"}`,
    };
    allCandidates.push(option);
  }

  // ---------------------------------------------------------------------------
  // Pass 2 — craftable and gatherable items
  // ---------------------------------------------------------------------------

  const candidateRows = allRows.filter(
    r => r.category === "crafted" || r.category === "gathered"
  );

  for (const row of candidateRows) {
    const id = row.item_id ?? "";
    if (!id) continue;

    // Hard filter: non-tradeable
    if (nonTradeable.has(id)) {
      filterLog[id] = "disableTrading=true (not sellable on marketplace)";
      continue;
    }

    // Hard filter: restricted industry
    if (row.industry && RESTRICTED_INDUSTRIES.has(row.industry)) {
      filterLog[id] = `restricted industry: ${row.industry}`;
      continue;
    }

    // Hard filter: animal product (chance yields)
    if (row.industry === "animal product") {
      filterLog[id] = "animal product (non-deterministic yield)";
      continue;
    }

    // Level gate (silent)
    if ((row.level_required ?? 0) > 0) {
      const pLevel = playerLevelForSkill(row.skill, playerSkills);
      if (pLevel < (row.level_required ?? 0)) continue;
    }

    // Must have a market price
    const priceRow = getMarketPrice(id);
    if (!priceRow) {
      if (row.category === "crafted") missingItems.add(id);
      filterLog[id] = "no market price yet";
      continue;
    }

    // Demand
    const sold7d = priceRow.sold_7d_est ?? 0;
    const { perDay: realPerDay, trend: realTrend } = getSalesRate(id);
    let salesPerDay: number;
    let trend:       "rising" | "steady" | "falling";
    let demandSource: DemandSource;

    if (sold7d > 0) {
      salesPerDay  = sold7d;
      trend        = "steady";
      demandSource = "purchasedQty";
    } else if (realPerDay > 0) {
      salesPerDay  = realPerDay;
      trend        = realTrend;
      demandSource = "real";
    } else {
      salesPerDay  = 0;
      trend        = "steady";
      demandSource = "none";
    }

    if (demandSource === "none") {
      filterLog[id] = "no real sales data yet";
      continue;
    }

    const sellPriceUnit = (priceRow.avg_sale_price > 0) ? priceRow.avg_sale_price : priceRow.avg_price;

    // --- Craftable-specific ---
    if (row.category === "crafted") {
      if (!row.skill) { filterLog[id] = "no skill in catalog"; continue; }

      const feasibility = inputsAreFeasible(row);
      if (!feasibility.ok) {
        filterLog[id] = `input chain: ${feasibility.reason}`;
        continue;
      }

      const { cost: rawInputCost, anyUnknown } = ingredientCost(row);
      if (anyUnknown) {
        filterLog[id] = "ingredient has no market price (cost unknown)";
        continue;
      }

      const outputQty   = row.recipe_output_qty ?? 1;
      const craftEnergy = row.craft_energy ?? 1;
      const totalSell   = sellPriceUnit * outputQty;
      const profitPerCraft = totalSell - rawInputCost;

      if (profitPerCraft <= 0) {
        filterLog[id] = `negative profit: sell=${totalSell.toFixed(0)} cost=${rawInputCost.toFixed(0)}`;
        continue;
      }

      const profitPerUnit  = profitPerCraft / outputQty;
      const energyPerUnit  = craftEnergy / outputQty;
      const runsForTarget  = Math.ceil(TARGET_MIN / profitPerCraft);
      const qtyForTarget   = runsForTarget * outputQty;
      const energyForTarget = runsForTarget * craftEnergy;
      const fitsEnergy     = energyMax > 0 ? energyForTarget <= energy : true;

      const priceTrend7d   = getPriceTrend7d(id);
      const trendBonus     = (priceTrend7d !== null && priceTrend7d > 0.1) ? 1.2 : 1.0;
      const normSales      = Math.min(salesPerDay / 200, 1);
      const normIng        = Math.min((ingUsage.get(id) ?? 0) / 50, 1);
      const normTb         = Math.min(getTaskboardFrequency(id) / 7, 1);
      const demandScore    = 0.5 * normSales + 0.3 * normIng + 0.2 * normTb;
      const finalScore     = (profitPerUnit / energyPerUnit) * demandScore * trendBonus;

      const ownedQty  = combinedInv[id] ?? 0;
      const ownedValue = ownedQty * sellPriceUnit;

      allCandidates.push({
        itemId: id,
        itemName: row.display_name ?? id,
        industry: row.industry ?? row.skill ?? "",
        skill: row.skill ?? "",
        isStaple:     staples.has(id),
        isOwnedStock: false,
        ownedQty,
        ownedValue,
        profitPerUnit,
        energyPerUnit,
        salesPerDay,
        trend,
        priceTrend7d,
        demandSource,
        qtyForTarget,
        energyForTarget,
        fitsEnergy,
        sellPrice:  sellPriceUnit,
        inputCost:  rawInputCost / outputQty,
        finalScore,
        debug: `crafted perDay=${salesPerDay.toFixed(1)} ppe=${(profitPerUnit / energyPerUnit).toFixed(1)} runs=${runsForTarget}×${outputQty} e=${energyForTarget} trend7d=${priceTrend7d !== null ? (priceTrend7d * 100).toFixed(0) + "%" : "n/a"}`,
      });
    }

    // --- Gatherable-specific ---
    if (row.category === "gathered") {
      // Skip fishing — very low yield predictability
      if (row.industry === "fishing") continue;

      const harvestEnergy = row.harvest_energy ?? 1;
      if (harvestEnergy <= 0) continue;

      const profitPerUnit = sellPriceUnit;
      const qtyForTarget  = Math.ceil(TARGET_MIN / sellPriceUnit);
      const energyForTarget = qtyForTarget * harvestEnergy;
      const fitsEnergy    = energyMax > 0 ? energyForTarget <= energy : true;

      const priceTrend7d  = getPriceTrend7d(id);
      const trendBonus    = (priceTrend7d !== null && priceTrend7d > 0.1) ? 1.2 : 1.0;
      const normSales     = Math.min(salesPerDay / 200, 1);
      const finalScore    = (sellPriceUnit / harvestEnergy) * normSales * trendBonus;

      const ownedQty  = combinedInv[id] ?? 0;
      const ownedValue = ownedQty * sellPriceUnit;

      allCandidates.push({
        itemId: id,
        itemName: row.display_name ?? id,
        industry: row.industry ?? "gather",
        skill:    row.skill ?? "",
        isStaple: staples.has(id),
        isOwnedStock: false,
        ownedQty,
        ownedValue,
        profitPerUnit,
        energyPerUnit: harvestEnergy,
        salesPerDay,
        trend,
        priceTrend7d,
        demandSource,
        qtyForTarget,
        energyForTarget,
        fitsEnergy,
        sellPrice: sellPriceUnit,
        inputCost: 0,
        finalScore,
        debug: `gathered perDay=${salesPerDay.toFixed(1)} spe=${(sellPriceUnit / harvestEnergy).toFixed(1)} qty=${qtyForTarget} e=${energyForTarget} trend7d=${priceTrend7d !== null ? (priceTrend7d * 100).toFixed(0) + "%" : "n/a"}`,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Rank: owned stock first (by ownedValue desc), then make-to-sell (by finalScore desc)
  // ---------------------------------------------------------------------------

  const ownedStock = allCandidates
    .filter(o => o.isOwnedStock)
    .sort((a, b) => b.ownedValue - a.ownedValue);

  const makeToSell = allCandidates
    .filter(o => !o.isOwnedStock)
    .sort((a, b) => b.finalScore - a.finalScore);

  // Top 3: owned stock fills first; make-to-sell fills the rest
  const topCraftOptions = [
    ...ownedStock.slice(0, 3),
    ...makeToSell.slice(0, Math.max(0, 3 - Math.min(ownedStock.length, 3))),
  ];
  const otherOpportunities = makeToSell.slice(topCraftOptions.length - ownedStock.slice(0, 3).length, 5);

  // ---------------------------------------------------------------------------
  // Taskboard coin options
  // ---------------------------------------------------------------------------

  const tbOrders: TaskboardCoinOption[] = [];
  if (Array.isArray(taskboard)) {
    for (const order of taskboard as Record<string, unknown>[]) {
      const reward = typeof order.reward === "number" ? order.reward
                   : typeof order.coins  === "number" ? order.coins : null;
      if (!reward) continue;
      const itemId = typeof order.itemId  === "string" ? order.itemId
                   : typeof order.item_id === "string" ? order.item_id : null;
      if (!itemId) continue;
      const qty      = typeof order.quantity === "number" ? order.quantity : 1;
      const priceRow = getMarketPrice(itemId);
      const inputCost = priceRow ? priceRow.min_price * qty : null;
      const profit    = inputCost !== null ? reward - inputCost : null;
      const itemName  = getCatalogRow(itemId)?.display_name ?? itemId;
      const detail = inputCost !== null
        ? `Deliver ${qty}× ${itemName} — reward ${reward.toLocaleString()} coins, buy cost ~${Math.round(inputCost).toLocaleString()}, profit ~${Math.round(profit!).toLocaleString()}`
        : `Deliver ${qty}× ${itemName} — reward ${reward.toLocaleString()} coins`;
      tbOrders.push({ itemId, itemName, reward, inputCost, profit, detail });
    }
    tbOrders.sort((a, b) => (b.profit ?? b.reward) - (a.profit ?? a.reward));
  }
  const topTaskboardOrders = tbOrders.slice(0, 2);

  // ---------------------------------------------------------------------------
  // Build code answer
  // ---------------------------------------------------------------------------

  const knownItemNames = new Set<string>();
  const lines: string[] = [];

  const hasAnything = topCraftOptions.length > 0 || topTaskboardOrders.length > 0;

  if (!hasAnything) {
    const craftableWithPrices = candidateRows.filter(r => r.item_id && getMarketPrice(r.item_id)).length;
    if (craftableWithPrices < 10) {
      lines.push("I'm still collecting market prices — keep the game open for a few minutes and ask again.");
    } else if (!chestsOpened) {
      lines.push(
        "Based on current market data I couldn't find profitable options for your skill levels right now.",
        "Open your storage chests so I can check whether you already have stock worth listing.",
      );
    } else {
      lines.push("Based on current market data, I couldn't find profitable options right now — prices may be low or demand is limited.");
    }
  } else {
    lines.push("Coin options (target: reach a 100K–200K listing):\n");
    let rank = 1;

    for (const opt of topCraftOptions) {
      knownItemNames.add(opt.itemName.toLowerCase());

      if (opt.isOwnedStock) {
        const chestNote = chestsOpened ? " across backpack + chests" : " in your backpack";
        const trendNote = opt.priceTrend7d !== null && opt.priceTrend7d > 0.1
          ? `, price up ${Math.round(opt.priceTrend7d * 100)}% this week`
          : "";
        const demandLabel = `~${opt.salesPerDay.toFixed(opt.salesPerDay >= 10 ? 0 : 1)} sold/day`;
        lines.push(
          `${rank}. You already have ${opt.ownedQty.toLocaleString()} ${opt.itemName}${chestNote}, worth ~${Math.round(opt.ownedValue).toLocaleString()} coins — list it now.`,
          `   (${demandLabel}${trendNote})`
        );
      } else if (opt.industry === "gathered" || opt.industry === "mine" || opt.industry === "forestry") {
        const toolNote = opt.skill ? ` (${opt.skill})` : "";
        const energyNote = opt.fitsEnergy
          ? `fits today's energy ✓`
          : `needs ${opt.energyForTarget.toLocaleString()} energy — spread over multiple days`;
        const trendNote = opt.priceTrend7d !== null && opt.priceTrend7d > 0.1
          ? `, price up ${Math.round(opt.priceTrend7d * 100)}% this week`
          : "";
        lines.push(
          `${rank}. Gather ${opt.itemName}${toolNote} — sells ~${Math.round(opt.sellPrice).toLocaleString()} each, ~${opt.salesPerDay.toFixed(opt.salesPerDay >= 10 ? 0 : 1)} sold/day${trendNote}.`,
          `   To list ~${Math.round(opt.qtyForTarget * opt.sellPrice / 1000)}K: gather ${opt.qtyForTarget.toLocaleString()} (${opt.energyForTarget.toLocaleString()} energy) — ${energyNote}.`
        );
      } else {
        const energyNote = opt.fitsEnergy
          ? `fits today's energy ✓`
          : `needs ${opt.energyForTarget.toLocaleString()} energy — spread over multiple days`;
        const trendNote = opt.priceTrend7d !== null && opt.priceTrend7d > 0.1
          ? `, price up ${Math.round(opt.priceTrend7d * 100)}% this week`
          : "";
        const inputNote = opt.inputCost > 0
          ? `, inputs ~${Math.round(opt.inputCost).toLocaleString()}/unit → ~${Math.round(opt.profitPerUnit).toLocaleString()} profit/unit`
          : "";
        lines.push(
          `${rank}. Craft ${opt.itemName} at ${opt.industry} — sells ~${Math.round(opt.sellPrice).toLocaleString()} each, ~${opt.salesPerDay.toFixed(opt.salesPerDay >= 10 ? 0 : 1)} sold/day${trendNote}${inputNote}.`,
          `   To list ~${Math.round(opt.qtyForTarget * opt.sellPrice / 1000)}K: make ${opt.qtyForTarget.toLocaleString()} (${opt.energyForTarget.toLocaleString()} energy) — ${energyNote}.`
        );
      }
      rank++;
    }

    for (const tb of topTaskboardOrders) {
      knownItemNames.add(tb.itemName.toLowerCase());
      lines.push(`${rank}. ${tb.detail}.`);
      rank++;
    }

    if (otherOpportunities.length > 0) {
      lines.push("\nOther opportunities:");
      for (const opt of otherOpportunities) {
        knownItemNames.add(opt.itemName.toLowerCase());
        const dayPart = `~${opt.salesPerDay.toFixed(opt.salesPerDay >= 10 ? 0 : 1)} sold/day`;
        lines.push(
          `• ${opt.itemName} — ${dayPart}, ~${Math.round(opt.profitPerUnit).toLocaleString()} profit/unit (${Math.round(opt.energyPerUnit)} energy each, ${opt.qtyForTarget.toLocaleString()} to reach 100K).`
        );
      }
    }

    if (energyMax > 0) {
      lines.push(`\nYou have ${Math.round(energy)}/${Math.round(energyMax)} energy today.`);
    }
    if (!chestsOpened) {
      lines.push("Open your storage chests so I can check whether you already have stock worth listing.");
    }
  }

  return {
    topCraftOptions,
    otherOpportunities,
    topTaskboardOrders,
    codeAnswer: lines.join("\n"),
    knownItemNames,
    missingMarketData: Array.from(missingItems),
    debug: {
      ownedStockCandidates: ownedStock.length,
      makeToSellCandidates: makeToSell.length,
      missingPrices:        missingItems.size,
      filterLog,
    },
  };
}

