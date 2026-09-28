import { fetchItems, fetchAchievements, fetchLocaleNameMap } from "./gameLibrary";
import { computeResourceAccess } from "./resourceAccess";

// ---------------------------------------------------------------------------
// Stop words — stripped before candidate extraction in findItemsInQuestion.
// ---------------------------------------------------------------------------

export const ITEM_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "not", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "it", "be", "was", "are", "were",
  "been", "has", "have", "had", "do", "did", "does", "will", "would", "could",
  "should", "may", "might", "shall", "can", "get", "got", "getting",
  "i", "me", "my", "you", "your", "we", "our", "they", "their",
  "this", "that", "these", "those", "what", "where", "when", "how", "why",
  "which", "who", "whom", "find", "buy", "need", "want", "use",
  "make", "craft", "farm", "grow", "mine", "level", "skill",
  "item", "stuff", "thing", "things", "some", "any", "all",
  "much", "many", "more", "most", "very", "so", "too", "also",
]);

// Game feature words that should never be used as single-word item candidates.
// "stacked app" etc. are multi-word phrases handled separately; these single words
// prevent spurious item matches like "stacked" → "Stacked Statue".
const FEATURE_SINGLE_WORDS = new Set([
  "stacked", "taskboard", "marketplace", "diary", "notebook", "faction", "guild",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CraftIngredient {
  id: string;
  name: string;
  quantity: number;
}

export interface ItemMatch {
  itemId: string;
  itemName: string;
  confidence: number;
  craftIngredients: CraftIngredient[] | null;
  requiredSkill: string | null;
  requiredLevel: number;
  harvestSources: string[];
  resourceAccess?: string | null;
}

// obtain-method values — extend once /api/catalog/obtain-methods confirms
// mining/fishing/animal-care field names from the live library response.
export type ObtainMethod = "plant_harvest" | "unknown";

// ---------------------------------------------------------------------------
// ResolveItemResult — returned by the shared resolveItemName function.
// ---------------------------------------------------------------------------

export type ResolveItemResult =
  | { kind: "found"; itemId: string; fuzzyDisplayName?: string }
  | { kind: "candidates"; items: Array<{ id: string; displayName: string }>; rawAmbiguous: boolean }
  | { kind: "not_found" };

// ---------------------------------------------------------------------------
// Damerau-Levenshtein distance (optimal string alignment, local copy)
// ---------------------------------------------------------------------------

function damerauLevenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const d: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[la][lb];
}

function fuzzyResolveFromNameMap(
  query: string,
  nameMap: Record<string, string>,
  maxDist: number,
): { itemId: string; displayName: string; distance: number } | null {
  const q = query.toLowerCase().trim();
  if (!q || q.length < 3) return null;
  const qWords = q.split(/\s+/);
  let best: { itemId: string; displayName: string; distance: number } | null = null;
  for (const [id, displayName] of Object.entries(nameMap)) {
    const name = displayName.toLowerCase();
    const fullDist = damerauLevenshtein(q, name);
    const nameWords = name.split(/\s+/);
    let wordDist = 0;
    for (const qw of qWords) {
      let bw = Infinity;
      for (const nw of nameWords) { const d = damerauLevenshtein(qw, nw); if (d < bw) bw = d; }
      wordDist += bw;
    }
    const minDist = Math.min(fullDist, wordDist);
    if (minDist <= maxDist && (!best || minDist < best.distance)) {
      best = { itemId: id, displayName, distance: minDist };
    }
  }
  return best;
}

export interface RecursiveLeaf {
  id: string;
  name: string;
  totalQuantity: number;
  obtainMethod: ObtainMethod;
  harvestSources: string[]; // non-empty only when obtainMethod === "plant_harvest"
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

export function scoreItemNameMatch(candidate: string, itemName: string): number {
  const a = candidate.toLowerCase().trim();
  const b = itemName.toLowerCase().trim();
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (b.includes(a) && a.length >= 4) return 0.85;
  if (a.includes(b) && b.length >= 4) return 0.8;
  const aTokens = new Set(a.split(/\s+/));
  const bTokens = b.split(/\s+/).filter((t) => t.length >= 2);
  if (bTokens.length < 2) return 0;
  const overlap = bTokens.filter((t) => aTokens.has(t)).length;
  if (overlap === bTokens.length) return 0.85;
  return 0;
}

export function extractItemCandidates(question: string): string[] {
  const words = question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  const filtered = words.filter((w) => !ITEM_STOP_WORDS.has(w));
  const candidates: string[] = [];
  if (filtered.length >= 2) candidates.push(filtered.join(" "));
  for (let i = 0; i < filtered.length - 1; i++) {
    candidates.push(`${filtered[i]} ${filtered[i + 1]}`);
  }
  for (const w of filtered) {
    if (w.length >= 4 && !FEATURE_SINGLE_WORDS.has(w)) candidates.push(w);
  }
  return [...new Set(candidates)];
}

// ---------------------------------------------------------------------------
// buildHarvestMap — itemId → producer-item names via onUse.plant.fruit.
// Extend this function once /api/catalog/obtain-methods confirms field names
// for mining nodes, fishing spots, and animal-care sources.
// ---------------------------------------------------------------------------

export function buildHarvestMap(
  allItems: Record<string, any>,
  nameMap: Record<string, string> = {},
): Record<string, string[]> {
  const harvestMap: Record<string, string[]> = {};
  for (const [producerId, item] of Object.entries(allItems)) {
    const fruitId: string | undefined = (item as any).onUse?.plant?.fruit;
    if (fruitId) {
      const producerName: string =
        nameMap[producerId] ?? (item as any).name ?? (item as any).label ?? "";
      if (producerName) {
        if (!harvestMap[fruitId]) harvestMap[fruitId] = [];
        harvestMap[fruitId].push(producerName);
      }
    }
  }
  return harvestMap;
}

// ---------------------------------------------------------------------------
// findCraftableForItem — shared lookup used by resolveCraftable and
// resolveCraftableRecursive; avoids duplicating the scan fallback.
// ---------------------------------------------------------------------------

function findCraftableForItem(
  itemId: string,
  allAchievements: Record<string, any>,
): Record<string, any> | null {
  const direct = allAchievements[itemId]?.craftable;
  if (direct) return direct as Record<string, any>;
  for (const a of Object.values(allAchievements)) {
    const aRec = a as Record<string, any>;
    const resultItems: any[] = aRec?.craftable?.result?.items ?? [];
    if (resultItems.some((ri: any) => ri?.id === itemId)) return aRec.craftable as Record<string, any>;
  }
  return null;
}

// ---------------------------------------------------------------------------
// resolveCraftable — single-level resolution (first-level ingredients only).
// Used by findItemsInQuestion for the /ask prompt injection.
// ---------------------------------------------------------------------------

export async function resolveCraftable(
  itemId: string,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
  nameMap: Record<string, string> = {},
): Promise<{ craftIngredients: CraftIngredient[] | null; requiredSkill: string | null; requiredLevel: number }> {
  const craftable = findCraftableForItem(itemId, allAchievements);

  if (!craftable) {
    return { craftIngredients: null, requiredSkill: null, requiredLevel: 0 };
  }

  const reqItems: any[] = craftable.requiredItems ?? [];
  const craftIngredients: CraftIngredient[] = reqItems.map((ri: any) => {
    const ingId: string = ri?.id ?? "";
    const ingName: string =
      nameMap[ingId] ?? allItems[ingId]?.name ?? allItems[ingId]?.label ?? ingId;
    return {
      id: ingId,
      name: ingName,
      quantity: typeof ri?.quantity === "number" ? ri.quantity : 1,
    };
  });

  return {
    craftIngredients,
    requiredSkill: typeof craftable.requiredSkill === "string" ? craftable.requiredSkill : null,
    requiredLevel: typeof craftable.requiredLevel === "number" ? craftable.requiredLevel : 0,
  };
}

// ---------------------------------------------------------------------------
// resolveCraftableRecursive — full multi-level ingredient flattening.
// Returns a Map<itemId, RecursiveLeaf> with quantities summed across all
// branches. cycle guard: path-based visited set with backtracking.
// ---------------------------------------------------------------------------

function _resolveRecursiveInternal(
  itemId: string,
  quantity: number,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
  harvestMap: Record<string, string[]>,
  leafMap: Map<string, RecursiveLeaf>,
  visited: Set<string>,
  nameMap: Record<string, string> = {},
): void {
  const resolvedName = (id: string) =>
    nameMap[id] ?? allItems[id]?.name ?? allItems[id]?.label ?? id;

  if (visited.has(itemId)) {
    console.warn(`[resolveCraftableRecursive] cycle at "${itemId}" — treating as leaf`);
    const name = resolvedName(itemId);
    const ex = leafMap.get(itemId);
    if (ex) { ex.totalQuantity += quantity; }
    else {
      leafMap.set(itemId, {
        id: itemId, name, totalQuantity: quantity,
        obtainMethod: harvestMap[itemId]?.length ? "plant_harvest" : "unknown",
        harvestSources: harvestMap[itemId] ?? [],
      });
    }
    return;
  }

  const craftable = findCraftableForItem(itemId, allAchievements);

  if (!craftable) {
    const name = resolvedName(itemId);
    const ex = leafMap.get(itemId);
    if (ex) { ex.totalQuantity += quantity; }
    else {
      leafMap.set(itemId, {
        id: itemId, name, totalQuantity: quantity,
        obtainMethod: harvestMap[itemId]?.length ? "plant_harvest" : "unknown",
        harvestSources: harvestMap[itemId] ?? [],
      });
    }
    return;
  }

  // Output quantity per craft — needed to scale ingredient quantities correctly.
  const resultItems: any[] = craftable.result?.items ?? [];
  const outputQty = resultItems.reduce((sum: number, ri: any) => {
    if (ri?.id === itemId) return sum + (typeof ri?.quantity === "number" ? ri.quantity : 1);
    return sum;
  }, 0) || 1;

  const craftsNeeded = Math.ceil(quantity / outputQty);

  visited.add(itemId);
  const requiredItems: any[] = craftable.requiredItems ?? [];
  for (const ri of requiredItems) {
    const ingId: string = ri?.id ?? "";
    if (!ingId) continue;
    const ingQty = (typeof ri?.quantity === "number" ? ri.quantity : 1) * craftsNeeded;
    _resolveRecursiveInternal(ingId, ingQty, allItems, allAchievements, harvestMap, leafMap, visited, nameMap);
  }
  visited.delete(itemId); // backtrack so sibling branches don't see this node
}

/**
 * Recursively flatten all leaf ingredients for itemId × quantity.
 * Pass allItems, allAchievements (already fetched), and a pre-built harvestMap.
 * Returns a Map keyed by ingredient item ID with summed total quantities.
 * Top-level items with no craftable recipe are returned as a single leaf.
 */
export function resolveCraftableRecursive(
  itemId: string,
  quantity: number,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
  harvestMap: Record<string, string[]>,
  visited: Set<string> = new Set(),
  nameMap: Record<string, string> = {},
): Map<string, RecursiveLeaf> {
  const leafMap = new Map<string, RecursiveLeaf>();
  _resolveRecursiveInternal(itemId, quantity, allItems, allAchievements, harvestMap, leafMap, new Set(visited), nameMap);
  return leafMap;
}

// ---------------------------------------------------------------------------
// computeCraftingBreakdown — deterministic crafting-math for targetItemId × qty.
// Returns direct ingredients, recursive raw leaves, energy/time/XP totals.
// ---------------------------------------------------------------------------

export interface CraftingBreakdown {
  targetItemId: string;
  targetItemName: string;
  targetQty: number;
  craftable: boolean;
  craftsNeeded: number;
  outputPerCraft: number;
  energyPerCraft: number;
  minutesPerCraft: number;
  requiredSkill: string | null;
  requiredLevel: number;
  xpPerCraft: number;
  directIngredients: Array<{ id: string; name: string; qtyPerCraft: number; totalQty: number }>;
  rawLeaves: Map<string, RecursiveLeaf>;
}

export function computeCraftingBreakdown(
  targetItemId: string,
  targetQty: number,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
  harvestMap: Record<string, string[]>,
  nameMap: Record<string, string> = {},
  inventory: Record<string, number> = {},
): CraftingBreakdown {
  const resolvedName = (id: string): string =>
    nameMap[id] ?? allItems[id]?.label ?? allItems[id]?.name ?? id;

  const targetItemName = resolvedName(targetItemId);
  const craftable = findCraftableForItem(targetItemId, allAchievements);

  if (!craftable) {
    return {
      targetItemId, targetItemName, targetQty, craftable: false,
      craftsNeeded: 0, outputPerCraft: 0, energyPerCraft: 0, minutesPerCraft: 0,
      requiredSkill: null, requiredLevel: 0, xpPerCraft: 0,
      directIngredients: [], rawLeaves: new Map(),
    };
  }

  const resultItems: any[] = craftable.result?.items ?? [];
  const outputPerCraft = resultItems.reduce((sum: number, ri: any) => {
    if (ri?.id === targetItemId) return sum + (typeof ri?.quantity === "number" ? ri.quantity : 1);
    return sum;
  }, 0) || 1;

  const craftsNeeded = Math.ceil(targetQty / outputPerCraft);
  const energyPerCraft = typeof craftable.energy === "number" ? craftable.energy : 0;
  const minutesPerCraft = typeof craftable.minutesRequired === "number" ? craftable.minutesRequired : 0;
  const requiredSkill = typeof craftable.requiredSkill === "string" ? craftable.requiredSkill : null;
  const requiredLevel = typeof craftable.requiredLevel === "number" ? craftable.requiredLevel : 0;
  const exps: any[] = craftable.result?.exps ?? [];
  const xpPerCraft = exps.reduce((s: number, e: any) => s + (typeof e?.exp === "number" ? e.exp : 0), 0);

  const reqItems: any[] = craftable.requiredItems ?? [];
  const directIngredients = reqItems.map((ri: any) => {
    const id: string = ri?.id ?? "";
    const qtyPerCraft = typeof ri?.quantity === "number" ? ri.quantity : 1;
    return { id, name: resolvedName(id), qtyPerCraft, totalQty: qtyPerCraft * craftsNeeded };
  });

  const rawLeaves = resolveCraftableRecursive(
    targetItemId, targetQty, allItems, allAchievements, harvestMap, new Set(), nameMap,
  );

  return {
    targetItemId, targetItemName, targetQty, craftable: true,
    craftsNeeded, outputPerCraft, energyPerCraft, minutesPerCraft,
    requiredSkill, requiredLevel, xpPerCraft,
    directIngredients, rawLeaves,
  };
}

export function formatCraftingMathSection(
  bd: CraftingBreakdown,
  inventory: Record<string, number> = {},
): string {
  if (!bd.craftable) {
    return `Crafting math: ${bd.targetItemName} not found in crafting recipes.`;
  }

  const lines: string[] = [
    "Crafting math (ground truth — use these numbers exactly, do not recalculate):",
    `To make ${bd.targetQty}× ${bd.targetItemName}:`,
    `  Crafts needed: ${bd.craftsNeeded} (recipe gives ${bd.outputPerCraft} per craft)`,
  ];

  if (bd.requiredSkill && bd.requiredLevel > 0) {
    lines.push(`  Required: ${bd.requiredSkill} level ${bd.requiredLevel}`);
  }
  if (bd.energyPerCraft > 0) {
    lines.push(`  Energy: ${bd.energyPerCraft}/craft × ${bd.craftsNeeded} = ${bd.energyPerCraft * bd.craftsNeeded} total`);
  }
  if (bd.minutesPerCraft > 0) {
    lines.push(`  Time: ${bd.minutesPerCraft} min/craft × ${bd.craftsNeeded} = ${bd.minutesPerCraft * bd.craftsNeeded} min total`);
  }
  if (bd.xpPerCraft > 0) {
    lines.push(`  XP: ${bd.xpPerCraft}/craft × ${bd.craftsNeeded} = ${bd.xpPerCraft * bd.craftsNeeded} total`);
  }

  lines.push(`  Ingredients (per craft → total for ${bd.craftsNeeded} crafts):`);
  for (const ing of bd.directIngredients) {
    if (!ing.id) continue;
    const have = inventory[ing.id] ?? 0;
    const still = Math.max(0, ing.totalQty - have);
    const invNote = have > 0 ? ` (have ${have}, still need ${still})` : "";
    lines.push(`    ${ing.qtyPerCraft}×/craft → ${ing.totalQty}× ${ing.name}${invNote}`);
  }

  // Show flattened raw leaves only when they differ from direct ingredients
  // (i.e., at least one direct ingredient is itself craftable and was expanded)
  const directIds = new Set(bd.directIngredients.map((d) => d.id));
  const hasMultiLevel = bd.directIngredients.some((di) => !bd.rawLeaves.has(di.id) && di.id !== "");
  if (hasMultiLevel) {
    lines.push(`  Raw materials (fully resolved):`);
    for (const [id, leaf] of bd.rawLeaves) {
      const have = inventory[id] ?? 0;
      const still = Math.max(0, leaf.totalQuantity - have);
      const invNote = have > 0 ? ` (have ${have}, still need ${still})` : "";
      lines.push(`    ${leaf.totalQuantity}× ${leaf.name}${invNote}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// buildCraftableItemsSet — precompute set of item IDs that have a crafting recipe.
// Uses both result.items and the conventional ach_foo → itm_foo key mapping.
// ---------------------------------------------------------------------------

export function buildCraftableItemsSet(
  allAchievements: Record<string, any>,
  allItems: Record<string, any>,
): Set<string> {
  const craftableItems = new Set<string>();
  for (const [achId, ach] of Object.entries(allAchievements)) {
    const craftable = (ach as any)?.craftable;
    if (!craftable) continue;
    const resultItems: any[] = craftable.result?.items ?? [];
    for (const ri of resultItems) {
      if (ri?.id) craftableItems.add(ri.id as string);
    }
    // Conventional: ach_grumpkingspicedlatte → itm_grumpkingspicedlatte.
    // Handles recipes where result.items is absent/empty — craftable still signals it's crafted.
    if (achId.startsWith("ach_")) {
      const conventionalId = "itm_" + achId.slice(4);
      if (allItems[conventionalId] !== undefined) craftableItems.add(conventionalId);
    }
  }
  return craftableItems;
}

// ---------------------------------------------------------------------------
// isRawItem — true when item is gatherable/harvestable, not produced by crafting.
// An item with a craftable recipe is never raw even if it has requirements.levels.
// Seeds (items with onUse.plant.fruit) are excluded unless the query asks for them.
// ---------------------------------------------------------------------------

function isRawItem(
  id: string,
  cropFruits: Set<string>,
  craftableItems: Set<string>,
  seedItems: Set<string>,
  allItems: Record<string, any>,
  queryIncludesSeed: boolean,
): boolean {
  if (craftableItems.has(id)) return false;
  if (seedItems.has(id) && !queryIncludesSeed) return false;
  return (
    cropFruits.has(id) ||
    /^itm_(roughstone|silicates|metalore|coal|woodlog)_/.test(id) ||
    ((allItems[id]?.requirements?.levels?.length ?? 0) > 0)
  );
}

// ---------------------------------------------------------------------------
// resolveItemName — shared single-item name resolver with raw-item priority.
//
// Returns:
//   { kind: "found",      itemId }                     — unambiguous match
//   { kind: "candidates", items, rawAmbiguous }         — multiple matches
//   { kind: "not_found" }                               — no match
//
// Uses three passes:
//   1. Exact case-insensitive display name
//   2. Normalized exact (strip non-alphanumeric)
//   3. Contains all tokens as whole words; raw/gatherable items ranked above crafted;
//      if ambiguous at same tier, returns candidates for the caller to resolve.
// ---------------------------------------------------------------------------

export function resolveItemName(
  query: string,
  nameMap: Record<string, string>,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
): ResolveItemResult {
  const raw = query.trim();
  if (!raw) return { kind: "not_found" };
  const lower = raw.toLowerCase();

  // Pass 1: exact case-insensitive
  for (const [id, displayName] of Object.entries(nameMap)) {
    if (displayName.toLowerCase().trim() === lower) return { kind: "found", itemId: id };
  }

  // Pass 2: normalized exact (strip non-alphanumeric)
  const norm = lower.replace(/[^a-z0-9]/g, "");
  if (norm.length >= 3) {
    for (const [id, displayName] of Object.entries(nameMap)) {
      if (displayName.toLowerCase().replace(/[^a-z0-9]/g, "") === norm) return { kind: "found", itemId: id };
    }
  }

  // Pass 3+4: contains all tokens as whole words with raw-item priority.
  const tokens = lower.split(/\s+/).filter((t) => t.length >= 1);

  // Pass 2b: merged tokens — "gravel glass" → try "gravelglass" as first word of a display name.
  // This catches items where the name is one CamelCase or compound word split by user.
  if (tokens.length >= 2) {
    const mergedNorm = tokens.join("").replace(/[^a-z0-9]/g, "");
    if (mergedNorm.length >= 4) {
      const mergedMatches: Array<{ id: string; displayName: string }> = [];
      for (const [id, displayName] of Object.entries(nameMap)) {
        const firstWord = displayName.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, "");
        if (firstWord === mergedNorm) mergedMatches.push({ id, displayName });
      }
      if (mergedMatches.length === 1) return { kind: "found", itemId: mergedMatches[0].id };
      if (mergedMatches.length > 1) return { kind: "candidates", items: mergedMatches, rawAmbiguous: false };
    }
  }

  if (tokens.length >= 1) {
    const cropFruits = new Set<string>();
    const seedItems = new Set<string>();
    for (const [id, seed] of Object.entries(allItems)) {
      const fruit = (seed as any)?.onUse?.plant?.fruit;
      if (fruit) { cropFruits.add(fruit as string); seedItems.add(id); }
    }
    const craftableItems = buildCraftableItemsSet(allAchievements, allItems);
    const queryIncludesSeed = tokens.some((t) => t === "seed" || t === "seeds");

    const rawMatches: Array<{ id: string; displayName: string }> = [];
    const craftedMatches: Array<{ id: string; displayName: string }> = [];

    for (const [id, displayName] of Object.entries(nameMap)) {
      const nameTokens = new Set(displayName.toLowerCase().split(/\s+/));
      if (!tokens.every((t) => nameTokens.has(t))) continue;
      if (isRawItem(id, cropFruits, craftableItems, seedItems, allItems, queryIncludesSeed)) {
        rawMatches.push({ id, displayName });
      } else {
        craftedMatches.push({ id, displayName });
      }
    }

    if (rawMatches.length === 1) return { kind: "found", itemId: rawMatches[0].id };
    if (rawMatches.length > 1) return { kind: "candidates", items: rawMatches, rawAmbiguous: true };
    if (craftedMatches.length === 1) return { kind: "found", itemId: craftedMatches[0].id };
    if (craftedMatches.length > 1) return { kind: "candidates", items: craftedMatches, rawAmbiguous: false };
  }

  // Pass 3.5: singularize last word and retry passes 1–3
  // "slothmatos" → "slothmato", "seeds" → "seed", "butterberries" → "butterberry"
  {
    const words = raw.split(/\s+/);
    const last = words[words.length - 1].toLowerCase();
    let singLast = last;
    if (last.endsWith("ies") && last.length > 4) singLast = last.slice(0, -3) + "y";
    else if (last.endsWith("ses") && last.length > 5) singLast = last.slice(0, -2);
    else if (last.endsWith("ches") && last.length > 5) singLast = last.slice(0, -2);
    else if (last.endsWith("shes") && last.length > 5) singLast = last.slice(0, -2);
    else if (last.endsWith("s") && !last.endsWith("ss") && last.length > 3) singLast = last.slice(0, -1);
    if (singLast !== last) {
      const singQuery = [...words.slice(0, -1), singLast].join(" ");
      const singResult = resolveItemName(singQuery, nameMap, allItems, allAchievements);
      if (singResult.kind === "found") return singResult;
    }
  }

  // Pass 4: fuzzy DL ≤ 2 against display names in nameMap
  const fuzzyMatch = fuzzyResolveFromNameMap(raw, nameMap, 2);
  if (fuzzyMatch) {
    return { kind: "found", itemId: fuzzyMatch.itemId, fuzzyDisplayName: fuzzyMatch.displayName };
  }

  return { kind: "not_found" };
}

// ---------------------------------------------------------------------------
// findItemsInQuestion — extracts + matches item names from a question string
// ---------------------------------------------------------------------------

export async function findItemsInQuestion(
  question: string,
  inventory?: Record<string, number>,
  skills?: Record<string, number>,
): Promise<ItemMatch[]> {
  let allItems: Record<string, any>;
  let allAchievements: Record<string, any>;
  let nameMap: Record<string, string>;
  try {
    [allItems, allAchievements, nameMap] = await Promise.all([
      fetchItems(), fetchAchievements(), fetchLocaleNameMap(),
    ]);
  } catch {
    return [];
  }

  const candidates = extractItemCandidates(question);
  if (candidates.length === 0) return [];

  const harvestMap = buildHarvestMap(allItems, nameMap);

  // Precompute raw-item classification helpers (shared with Pass 2 sort tiebreaker).
  const cropFruits = new Set<string>();
  const seedItems = new Set<string>();
  for (const [id, seed] of Object.entries(allItems)) {
    const fruit = (seed as any)?.onUse?.plant?.fruit;
    if (fruit) { cropFruits.add(fruit as string); seedItems.add(id); }
  }
  const craftableItems = buildCraftableItemsSet(allAchievements, allItems);
  const lowerQuestion = question.toLowerCase();
  const queryIncludesSeed = /\bseeds?\b/.test(lowerQuestion);

  const bestMatches = new Map<string, { score: number }>();
  for (const candidate of candidates) {
    for (const itemId of Object.keys(allItems)) {
      const itemName: string = nameMap[itemId] ?? "";
      if (!itemName) continue;
      const score = scoreItemNameMatch(candidate, itemName);
      if (score >= 0.75) {
        const existing = bestMatches.get(itemId);
        if (!existing || score > existing.score) bestMatches.set(itemId, { score });
      }
    }
  }

  // Pass 2: prefix matching with raw-item priority.
  // "Grumpkin" → raw hits [Blue Grumpkin, Orange Grumpkin] take precedence over crafted.
  // Multiple raw hits are all added so the companion can list candidates.
  // Multiple crafted hits without any raw hit: only add when exactly one.
  for (const candidate of candidates) {
    const inputTokens = candidate.split(/\s+/).filter((t) => t.length >= 1);
    if (inputTokens.length === 0) continue;
    const prefixRaw: string[] = [];
    const prefixCrafted: string[] = [];
    for (const itemId of Object.keys(allItems)) {
      if (bestMatches.has(itemId)) continue;
      const displayName = nameMap[itemId] ?? "";
      if (!displayName) continue;
      const nameTokens = displayName.toLowerCase().split(/\s+/);
      if (
        inputTokens.length <= nameTokens.length &&
        inputTokens.every((t, i) => nameTokens[i] === t)
      ) {
        if (isRawItem(itemId, cropFruits, craftableItems, seedItems, allItems, queryIncludesSeed)) {
          prefixRaw.push(itemId);
        } else {
          prefixCrafted.push(itemId);
        }
      }
    }
    const toAdd = prefixRaw.length > 0 ? prefixRaw : prefixCrafted.length === 1 ? prefixCrafted : [];
    for (const id of toAdd) {
      const existing = bestMatches.get(id);
      if (!existing || 0.78 > existing.score) bestMatches.set(id, { score: 0.78 });
    }
  }

  if (bestMatches.size === 0) return [];

  // Sort by score; use raw-item status as tiebreaker so raw/gatherable items
  // rank above crafted products at the same score.
  const sorted = [...bestMatches.entries()]
    .sort((a, b) => {
      const diff = b[1].score - a[1].score;
      if (Math.abs(diff) > 0.001) return diff;
      const aRaw = isRawItem(a[0], cropFruits, craftableItems, seedItems, allItems, queryIncludesSeed) ? 1 : 0;
      const bRaw = isRawItem(b[0], cropFruits, craftableItems, seedItems, allItems, queryIncludesSeed) ? 1 : 0;
      return bRaw - aRaw;
    })
    .slice(0, 3);

  const results: ItemMatch[] = [];
  for (const [itemId, { score }] of sorted) {
    const itemName: string = nameMap[itemId] ?? itemId;
    const { craftIngredients, requiredSkill, requiredLevel } = await resolveCraftable(
      itemId,
      allItems,
      allAchievements,
      nameMap,
    );

    let resourceAccess: string | null = null;
    if (inventory !== undefined || skills !== undefined) {
      const inv = inventory ?? {};
      const skl = skills ?? {};
      try {
        const ra = await computeResourceAccess(itemId, inv, skl, nameMap);
        resourceAccess = ra?.summary ?? null;
      } catch {
        resourceAccess = null;
      }
    }

    results.push({
      itemId,
      itemName,
      confidence: score,
      craftIngredients,
      requiredSkill,
      requiredLevel,
      harvestSources: harvestMap[itemId] ?? [],
      resourceAccess,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// formatItemDataSection — prompt section for ask.ts
// ---------------------------------------------------------------------------

export function formatItemDataSection(matches: ItemMatch[]): string | null {
  if (matches.length === 0) return null;

  const lines: string[] = [
    "Item data from game library (ground truth — use this, do not guess or invent):",
  ];

  for (const m of matches) {
    lines.push(`\n${m.itemName}:`);

    if (m.craftIngredients && m.craftIngredients.length > 0) {
      const ingStr = m.craftIngredients.map((i) => `${i.quantity}x ${i.name}`).join(", ");
      const reqStr =
        m.requiredSkill && m.requiredLevel > 0
          ? ` (requires ${m.requiredSkill} level ${m.requiredLevel})`
          : "";
      lines.push(`  Crafting recipe: ${ingStr}${reqStr}`);
    } else if (m.craftIngredients !== null) {
      lines.push("  Crafting: no ingredients required");
    }

    if (m.harvestSources.length > 0) {
      lines.push(`  Obtained by harvesting: ${m.harvestSources.join(", ")}`);
    }

    if (m.craftIngredients === null && m.harvestSources.length === 0 && !m.resourceAccess) {
      lines.push(
        "  Source: not in catalog craft recipes or plant harvests",
      );
    }

    if (m.resourceAccess) {
      lines.push(`  ${m.resourceAccess}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// collectObtainMethodPaths — diagnostic: walks every item's onUse object and
// returns {path: count} sorted by frequency. Call GET /api/catalog/obtain-methods
// on the live server to discover what field names actually exist under onUse for
// mining, fishing, and animal-care items before extending buildHarvestMap.
// ---------------------------------------------------------------------------

export function collectObtainMethodPaths(allItems: Record<string, any>): Record<string, number> {
  const counts: Record<string, number> = {};
  function walk(obj: unknown, prefix: string): void {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const path = `${prefix}.${k}`;
      counts[path] = (counts[path] ?? 0) + 1;
      walk(v, path);
    }
  }
  for (const item of Object.values(allItems)) {
    const onUse = (item as any).onUse;
    if (onUse && typeof onUse === "object") walk(onUse, "onUse");
  }
  return counts;
}
