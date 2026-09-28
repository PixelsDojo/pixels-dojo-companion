import crypto from "crypto";
import { fetchItems, fetchAchievements, fetchLocaleNameMap } from "./gameLibrary";
import {
  db, CatalogRow,
  upsertCatalogRow, getCatalogRow, listCatalogRows, countCatalogRows,
  clearCatalog, getCatalogMeta, upsertCatalogMeta, getAllLocaleRows,
} from "../db/database";

// Bump this whenever builder logic or schema changes so Railway auto-rebuilds.
const CATALOG_BUILDER_VERSION = "7";

// ---------------------------------------------------------------------------
// Damerau-Levenshtein distance (optimal string alignment)
// ---------------------------------------------------------------------------

export function damerauLevenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const d: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
      }
    }
  }
  return d[la][lb];
}

// ---------------------------------------------------------------------------
// Classify items from library data — mirrors the logic in resourceAccess.ts
// ---------------------------------------------------------------------------

const GATHERING_FAMILIES: Array<{
  regex: RegExp;
  skill: string;
  industry: string;
  source_label?: string;
  entity_id?: string;
}> = [
  { regex: /^itm_roughstone_|^itm_silicates_|^itm_metalore_|^itm_coal_/, skill: "mining",   industry: "mine" },
  { regex: /^itm_woodlog_/,                                               skill: "forestry", industry: "forestry" },
  // Fish — internal skill is "exploration" (in-game: Exploration)
  { regex: /^itm_(?:common|uncommon|rare|epic|ultimate|fanatical)fish_/,  skill: "exploration", industry: "fishing" },
  { regex: /^itm_fish_\d+$/,                                               skill: "exploration", industry: "fishing" },
  // Animal products — placed animals and buildings. Skill "petcare" (in-game: Animal Care).
  // source_label: "Animal: X" = placed on land; "Coop"/"Apiary"/"Sluggery" = building.
  { regex: /^itm_cow_(?!01$)/,               skill: "petcare", industry: "animal product", source_label: "Animal: Cow",    entity_id: "ent_cow_pickup"    },
  { regex: /^itm_sheep_(?!01$)/,             skill: "petcare", industry: "animal product", source_label: "Animal: Sheep",  entity_id: "ent_sheep_01"      },
  { regex: /^itm_goat_/,                     skill: "petcare", industry: "animal product", source_label: "Animal: Goat",   entity_id: "ent_legacy_goat"   },
  { regex: /^itm_pig_/,                      skill: "petcare", industry: "animal product", source_label: "Animal: Pig",    entity_id: "ent_legacy_pig"    },
  { regex: /^itm_bee_/,                      skill: "petcare", industry: "animal product", source_label: "Apiary",         entity_id: "ent_apiary"        },
  { regex: /^itm_duck_/,                     skill: "petcare", industry: "animal product", source_label: "Animal: Duck",   entity_id: "ent_legacy_duck"   },
  { regex: /^itm_turkey_(?!01$)/,            skill: "petcare", industry: "animal product", source_label: "Animal: Turkey", entity_id: "ent_turkey"        },
  { regex: /^itm_dragon_/,                   skill: "petcare", industry: "animal product", source_label: "Animal: Dragon", entity_id: "ent_legacy_dragon" },
  { regex: /^itm_silkslug(?:slime|spider)$/, skill: "petcare", industry: "animal product", source_label: "Sluggery",       entity_id: "ent_sluggery"      },
  { regex: /^itm_chicken_spaceEgg$/,         skill: "petcare", industry: "animal product", source_label: "Coop",           entity_id: "ent_coop"          },
  // Singles — each needs its own entry to carry the correct source
  { regex: /^itm_honey$/,                    skill: "petcare", industry: "animal product", source_label: "Apiary",         entity_id: "ent_apiary"        },
  { regex: /^itm_beeswax$/,                  skill: "petcare", industry: "animal product", source_label: "Apiary",         entity_id: "ent_apiary"        },
  { regex: /^itm_milk$/,                     skill: "petcare", industry: "animal product", source_label: "Animal: Cow",    entity_id: "ent_cow_pickup"    },
  { regex: /^itm_egg$/,                      skill: "petcare", industry: "animal product", source_label: "Coop",           entity_id: "ent_coop"          },
];

// Items that require a specific land type — confirmed by Lizzy.
// Key = item_id, value = { land_type, category, industry, skill }
const LAND_LOCKED_ITEMS: Record<string, {
  land_type: string;
  category: "gathered" | "crop";
  industry: string;
  skill: string;
  seedId?: string;        // for crops: the seed item ID
  seedName?: string;      // for crops: the seed display name
}> = {
  // MINED items with land type (IDs don't match GATHERING_FAMILIES regex)
  itm_salt:           { land_type: "WATER", category: "gathered", industry: "mine",    skill: "mining"   },
  itm_magnetite_ore:  { land_type: "GRASS", category: "gathered", industry: "mine",    skill: "mining"   },
  itm_void:           { land_type: "SPACE", category: "gathered", industry: "mine",    skill: "mining"   },
  // CROPS with land type
  itm_wintermintFruit:{ land_type: "WATER", category: "crop",     industry: "farm",    skill: "farming", seedId: "itm_wintermintSeeds"  },
  itm_magnoot:        { land_type: "GRASS", category: "crop",     industry: "farm",    skill: "farming", seedId: "itm_magnoot_seeds"    },
  itm_tenta:          { land_type: "SPACE", category: "crop",     industry: "farm",    skill: "farming", seedId: "itm_tentacactus"      },
};

const LAND_TYPE_LABELS: Record<string, string> = {
  WATER: "water land",
  GRASS: "grass land",
  SPACE: "space land",
};

function tierFromId(id: string): number | null {
  const m = id.match(/_t(\d+)(?:_|$)/i);
  return m ? parseInt(m[1], 10) : null;
}

const TIER_MIN_LEVEL = [0, 0, 20, 40, 60, 80];
function levelForTier(tier: number): number {
  return TIER_MIN_LEVEL[Math.max(1, Math.min(5, tier))] ?? 0;
}

const TOOL_SKILL_PATTERNS: Array<{ regex: RegExp; skill: string; type: string }> = [
  { regex: /^itm_pickaxe/i, skill: "mining",   type: "pickaxe" },
  { regex: /^itm_axe/i,     skill: "forestry", type: "axe" },
  { regex: /^itm_shears/i,  skill: "farming",  type: "shears" },
];

function toolSkillFromId(id: string): { skill: string; type: string } | null {
  for (const p of TOOL_SKILL_PATTERNS) {
    if (p.regex.test(id)) return { skill: p.skill, type: p.type };
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildCatalogRow — classify a single item and return a CatalogRow
// ---------------------------------------------------------------------------

function buildCatalogRow(
  itemId: string,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
  nameMap: Record<string, string>,
  libraryVer: string,
): Omit<CatalogRow, "updated_at"> | null {
  const item = allItems[itemId];
  const displayName = nameMap[itemId] ?? item?.name ?? item?.label;
  if (!displayName) return null; // no display name → skip

  const base: Omit<CatalogRow, "updated_at"> = {
    item_id: itemId,
    display_name: displayName,
    category: null, industry: null, tier: item?.tier ?? null,
    skill: null, level_required: null, tool_type: null, tool_min_tier: null,
    seed_id: null, seed_name: null, grow_time_minutes: null,
    plant_energy: null, harvest_energy: null, harvest_xp: null,
    recipe_station: null, recipe_inputs: null, recipe_output_qty: null,
    craft_time_minutes: null, craft_energy: null, craft_xp: null,
    is_event_recipe: 0, all_recipes: null, land_type: null, library_ver: libraryVer,
  };

  // -- Step 0: item.requirements.levels → gather skill (farming/mining/forestry only)
  // Guard: seeds also have farming level requirements — handle them in Step 1.6 instead.
  if (item?.requirements?.levels?.length > 0 && !item?.onUse?.plant?.fruit) {
    const req = item.requirements.levels[0];
    const skill: string | null = typeof req.levelType === "string" ? req.levelType.toLowerCase() : null;
    const lvl: number | null = typeof req.level === "number" ? req.level : null;
    if (skill === "farming" || skill === "mining" || skill === "forestry") {
      const industryMap: Record<string, string> = { farming: "farm", mining: "mine", forestry: "forestry" };
      return { ...base, category: "gathered", industry: industryMap[skill] ?? skill, skill, level_required: lvl };
    }
  }

  // -- Step 0.5: land-locked items override (mined on specific land type, or land-specific crops)
  if (LAND_LOCKED_ITEMS[itemId]) {
    const ll = LAND_LOCKED_ITEMS[itemId];
    const seedName = ll.seedName
      ?? (ll.seedId ? (nameMap[ll.seedId] ?? allItems[ll.seedId]?.name ?? ll.seedId) : null);
    const seedEntry = ll.seedId ? allItems[ll.seedId] : null;
    const farmingReq = seedEntry?.requirements?.levels?.find((r: any) => r.levelType === "farming");
    const growTime: number | null = typeof seedEntry?.onUse?.plant?.growTime === "number"
      ? seedEntry.onUse.plant.growTime : null;
    const harvestXP: number | null = typeof seedEntry?.onUse?.plant?.harvestXP === "number"
      ? seedEntry.onUse.plant.harvestXP : null;
    const harvestNRG: number | null = typeof seedEntry?.onUse?.plant?.harvestNRG === "number"
      ? seedEntry.onUse.plant.harvestNRG : null;
    const rawEnergy = seedEntry?.onUse?.energy?.value;
    const plantEnergy: number | null = typeof rawEnergy === "number" ? Math.abs(rawEnergy) : null;
    // Level requirement for mined items: from item.requirements.levels if present
    const miningReq = item?.requirements?.levels?.find((r: any) =>
      typeof r.levelType === "string" && r.levelType.toLowerCase() === "mining"
    );
    return {
      ...base,
      category: ll.category,
      industry: ll.industry,
      skill: ll.skill,
      level_required: ll.category === "crop"
        ? (farmingReq?.level ?? null)
        : (miningReq?.level ?? null),
      land_type: ll.land_type,
      ...(ll.category === "crop" && ll.seedId ? {
        seed_id: ll.seedId,
        seed_name: seedName,
        grow_time_minutes: growTime,
        plant_energy: plantEnergy,
        harvest_energy: harvestNRG,
        harvest_xp: harvestXP,
      } : {}),
    };
  }

  // -- Step 1: craftable — collect ALL achievement entries that produce this item
  const achKey = itemId.startsWith("itm_") ? "ach_" + itemId.slice(4) : null;
  const craftableEntries: Array<{ achId: string; craftable: any }> = [];

  const seenAchs = new Set<string>();
  // Priority: direct ID, then conventional ach_ key, then full scan
  for (const [candidateId, candidateCraftable] of [
    [itemId,  allAchievements[itemId]?.craftable],
    [achKey,  achKey ? allAchievements[achKey]?.craftable : undefined],
  ] as [string | null, any][]) {
    if (!candidateId || !candidateCraftable || seenAchs.has(candidateId)) continue;
    if (candidateCraftable.result?.items?.some((ri: any) => ri?.id === itemId)) {
      craftableEntries.push({ achId: candidateId, craftable: candidateCraftable });
      seenAchs.add(candidateId);
    }
  }
  // Full scan — finds ALL recipes including bulk/pile/event variants
  for (const [achId, ach] of Object.entries(allAchievements)) {
    if (seenAchs.has(achId)) continue;
    const c = (ach as any)?.craftable;
    if (c?.result?.items?.some((ri: any) => ri?.id === itemId)) {
      craftableEntries.push({ achId, craftable: c });
      seenAchs.add(achId);
    }
  }

  if (craftableEntries.length > 0) {
    // Sort ascending by requiredLevel so primary = lowest-requirement recipe
    craftableEntries.sort((a, b) => {
      const la = typeof a.craftable.requiredLevel === "number" ? a.craftable.requiredLevel : 0;
      const lb = typeof b.craftable.requiredLevel === "number" ? b.craftable.requiredLevel : 0;
      return la - lb;
    });

    const buildRecipeData = (c: any) => {
      const reqItems: any[] = c.requiredItems ?? [];
      const inputs = reqItems.map((ri: any) => ({
        id: ri?.id ?? "",
        name: nameMap[ri?.id] ?? allItems[ri?.id]?.name ?? allItems[ri?.id]?.label ?? ri?.id ?? "",
        qty: typeof ri?.quantity === "number" ? ri.quantity : 1,
      }));
      const resultItems: any[] = c.result?.items ?? [];
      const outputQty = resultItems.reduce((s: number, ri: any) => ri?.id === itemId ? s + (ri?.quantity ?? 1) : s, 0) || 1;
      const exps: any[] = c.result?.exps ?? [];
      const craftXp = exps.reduce((s: number, e: any) => s + (typeof e?.exp === "number" ? e.exp : 0), 0);
      return {
        station: typeof c.type === "string" ? c.type : null,
        skill: typeof c.requiredSkill === "string" ? c.requiredSkill.toLowerCase() : null,
        levelRequired: typeof c.requiredLevel === "number" ? c.requiredLevel : null,
        inputs,
        outputQty,
        craftTimeMinutes: typeof c.minutesRequired === "number" ? c.minutesRequired : null,
        energy: typeof c.energy === "number" ? c.energy : null,
        craftXp: craftXp || null,
        isEvent: /quest|event|seasonal/i.test(c.type ?? "") ? 1 : 0,
      };
    };

    const primary = buildRecipeData(craftableEntries[0].craftable);
    const allRecipesData = craftableEntries.map(({ achId, craftable: c }) => ({
      achId,
      ...buildRecipeData(c),
    }));

    return {
      ...base,
      category: "crafted",
      industry: primary.station ?? primary.skill ?? null,
      skill: primary.skill,
      level_required: primary.levelRequired,
      recipe_station: primary.station,
      recipe_inputs: primary.inputs.length > 0 ? JSON.stringify(primary.inputs) : null,
      recipe_output_qty: primary.outputQty,
      craft_time_minutes: primary.craftTimeMinutes,
      craft_energy: primary.energy,
      craft_xp: primary.craftXp,
      is_event_recipe: primary.isEvent,
      all_recipes: craftableEntries.length > 1 ? JSON.stringify(allRecipesData) : null,
    };
  }

  // -- Step 1.5: GATHERING_FAMILIES
  for (const fam of GATHERING_FAMILIES) {
    if (fam.regex.test(itemId)) {
      const srcTier = typeof item?.tier === "number" && item.tier > 0 ? item.tier : null;
      return {
        ...base,
        category: "gathered",
        industry: fam.industry,
        skill: fam.skill,
        level_required: srcTier !== null ? levelForTier(srcTier) : null,
        // Animal products: repurpose recipe_station for source label, seed_id for entity reference.
        recipe_station: fam.source_label ?? null,
        seed_id: fam.entity_id ?? null,
      };
    }
  }

  // -- Step 1.6: SEEDS — items with onUse.plant.fruit (sold at Buck's shop)
  if (item?.onUse?.plant?.fruit) {
    const fruitId: string = item.onUse.plant.fruit;
    const fruitName = nameMap[fruitId] ?? allItems[fruitId]?.name ?? allItems[fruitId]?.label ?? fruitId;
    const farmingReq = item?.requirements?.levels?.find((r: any) => r.levelType === "farming");
    const growTime: number | null = typeof item.onUse.plant.growTime === "number" ? item.onUse.plant.growTime : null;
    return {
      ...base,
      category: "seed",
      industry: "farming",
      skill: "farming",
      level_required: farmingReq?.level ?? null,
      seed_id: fruitId,
      seed_name: fruitName,
      grow_time_minutes: growTime,
    };
  }

  // -- Step 2: farming crop — find seed whose fruit === itemId
  for (const [seedId, seed] of Object.entries(allItems)) {
    if ((seed as any)?.onUse?.plant?.fruit !== itemId) continue;
    const plant = (seed as any).onUse.plant;
    const seedTier: number | null = typeof (seed as any).tier === "number" && (seed as any).tier > 0 ? (seed as any).tier : null;
    const lvlRequired: number | null =
      (seed as any)?.requirements?.levels?.[0]?.level ??
      (seedTier !== null ? levelForTier(seedTier) : null);
    const growTime: number | null = typeof plant.growTime === "number" ? plant.growTime : null;
    const harvestXP: number | null = typeof plant.harvestXP === "number" ? plant.harvestXP : null;
    const harvestNRG: number | null = typeof plant.harvestNRG === "number" ? plant.harvestNRG : null;
    const rawEnergy = (seed as any)?.onUse?.energy?.value;
    const plantEnergy: number | null = typeof rawEnergy === "number" ? Math.abs(rawEnergy) : null;
    const seedName = nameMap[seedId] ?? (seed as any).name ?? (seed as any).label ?? seedId;
    return {
      ...base,
      category: "crop",
      industry: "farm",
      tier: seedTier,
      skill: "farming",
      level_required: lvlRequired,
      tool_type: "shears",
      tool_min_tier: seedTier,
      seed_id: seedId,
      seed_name: seedName,
      grow_time_minutes: growTime,
      plant_energy: plantEnergy,
      harvest_energy: harvestNRG,
      harvest_xp: harvestXP,
    };
  }

  // -- Tool items (pickaxe/axe/shears) — skip entirely
  if (toolSkillFromId(itemId)) return null;

  // No classification found — include in catalog as unknown so we can answer honestly
  return { ...base, category: null };
}

// ---------------------------------------------------------------------------
// rebuildCatalogIfNeeded — check ver+hash, skip if unchanged.
// Pass force=true to bypass the hash check (e.g. from the debug endpoint).
// ---------------------------------------------------------------------------

export interface CatalogBreakdown {
  crop: number;
  seed: number;
  mined: number;
  chopped: number;
  animal: number;
  gathered_other: number;
  crafted: number;
  retired: number;
  skipped_no_name: number;
  unclassified: number;
}

export async function rebuildCatalogIfNeeded(
  force = false,
): Promise<{ built: boolean; itemCount: number; message: string; breakdown?: CatalogBreakdown }> {
  let allItems: Record<string, any>;
  let allAchievements: Record<string, any>;
  let nameMap: Record<string, string>;
  let libraryVer: string;

  try {
    [allItems, allAchievements, nameMap] = await Promise.all([
      fetchItems() as Promise<Record<string, any>>,
      fetchAchievements() as Promise<Record<string, any>>,
      fetchLocaleNameMap(),
    ]);
    libraryVer = "10.5";
  } catch (err) {
    return { built: false, itemCount: 0, message: `Library unavailable: ${err}` };
  }

  // Hash includes builder version so code changes auto-trigger a rebuild.
  const hashInput =
    Object.keys(allItems).sort().join(",") + "|" +
    Object.keys(allAchievements).sort().join(",") + "|v" + CATALOG_BUILDER_VERSION;
  const contentHash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, 16);

  const meta = getCatalogMeta();
  if (!force && meta && meta.library_ver === libraryVer && meta.content_hash === contentHash) {
    const count = countCatalogRows();
    return { built: false, itemCount: count, message: `Catalog current (ver=${libraryVer}, builder v${CATALOG_BUILDER_VERSION}, ${count} rows)` };
  }

  // ── Main item classification loop ──────────────────────────────────────────
  const now = Date.now();
  const rows: Array<Omit<CatalogRow, "updated_at">> = [];
  const addedIds = new Set<string>();

  const breakdown: CatalogBreakdown = {
    crop: 0, seed: 0, mined: 0, chopped: 0, animal: 0,
    gathered_other: 0, crafted: 0, retired: 0,
    skipped_no_name: 0, unclassified: 0,
  };

  const unknownRawMaterialIds: string[] = [];
  const RAW_MATERIAL_RE = /ore|stone|salt|sand|crystal|dust|gem|log|shell|mineral|metal|rock|coal|lum/i;

  for (const itemId of Object.keys(allItems)) {
    const row = buildCatalogRow(itemId, allItems, allAchievements, nameMap, libraryVer);
    if (!row) {
      // buildCatalogRow returns null only for items with no display name or tool items
      const displayName = nameMap[itemId] ?? allItems[itemId]?.name ?? allItems[itemId]?.label;
      if (!displayName) breakdown.skipped_no_name++;
      continue;
    }
    rows.push(row);
    addedIds.add(itemId);
    if (row.category === "crop")       breakdown.crop++;
    else if (row.category === "seed")  breakdown.seed++;
    else if (row.category === "gathered") {
      if      (row.industry === "mine")           breakdown.mined++;
      else if (row.industry === "forestry")       breakdown.chopped++;
      else if (row.industry === "animal product") breakdown.animal++;
      else                                         breakdown.gathered_other++;
    }
    else if (row.category === "crafted") breakdown.crafted++;
    else if (row.category === null) {
      breakdown.unclassified++;
      if (RAW_MATERIAL_RE.test(itemId) || RAW_MATERIAL_RE.test(row.display_name)) {
        unknownRawMaterialIds.push(`${itemId} (${row.display_name})`);
      }
    }
  }

  // ── Retired recipe detection ───────────────────────────────────────────────
  // An ach_*_name key in i18n whose achievement no longer exists in the library.
  const allLocaleRows = getAllLocaleRows();
  const seenRetiredNames = new Set<string>();

  for (const { key, text } of allLocaleRows) {
    if (!key.startsWith("ach_") || !key.endsWith("_name")) continue;
    const achKey = key.slice(0, -5);

    // Skip if achievement still exists (not retired)
    if (allAchievements[achKey]) continue;

    // Skip obvious non-recipe placeholder entries
    if (!text || text === "DEPRECATED") continue;

    // Deduplicate by display name (multiple ach_ variants of the same item)
    if (seenRetiredNames.has(text)) continue;
    seenRetiredNames.add(text);

    // Always use itm_* form — showing ach_* IDs to users is confusing
    const possibleItemId = "itm_" + achKey.slice(4);
    const itemExists = allItems[possibleItemId] !== undefined;
    const retiredItemId = possibleItemId;

    // Skip if already classified as crop/gathered/crafted
    if (addedIds.has(retiredItemId)) continue;

    rows.push({
      item_id: retiredItemId,
      display_name: text,
      category: "retired",
      industry: null, tier: allItems[possibleItemId]?.tier ?? null,
      skill: null, level_required: null,
      tool_type: null, tool_min_tier: null,
      seed_id: null, seed_name: null,
      grow_time_minutes: null, plant_energy: null, harvest_energy: null, harvest_xp: null,
      recipe_station: null, recipe_inputs: null, recipe_output_qty: null,
      craft_time_minutes: null, craft_energy: null, craft_xp: null,
      is_event_recipe: 0, all_recipes: null, land_type: null,
      library_ver: libraryVer,
    });
    addedIds.add(retiredItemId);
    breakdown.retired++;
  }

  // ── Detect removed items (were in catalog, not in new build) ───────────────
  const existingRows = listCatalogRows();
  const removedIds = existingRows.map(r => r.item_id).filter(id => !addedIds.has(id));

  // ── Write in a transaction ─────────────────────────────────────────────────
  const upsertAll = db.transaction(() => {
    for (const row of rows) upsertCatalogRow(row);
  });
  upsertAll();

  if (removedIds.length > 0) {
    const del = db.prepare<[string]>(`DELETE FROM game_catalog WHERE item_id = ?`);
    const delAll = db.transaction(() => { for (const id of removedIds) del.run(id); });
    delAll();
  }

  upsertCatalogMeta(libraryVer, contentHash, rows.length);

  const total = rows.length;
  const msg = [
    `Catalog rebuilt: ${total} rows`,
    `(crop=${breakdown.crop} seed=${breakdown.seed} mined=${breakdown.mined} chopped=${breakdown.chopped}`,
    `animal=${breakdown.animal} gathered_other=${breakdown.gathered_other} crafted=${breakdown.crafted}`,
    `retired=${breakdown.retired} skipped=${breakdown.skipped_no_name}`,
    `unclassified=${breakdown.unclassified})`,
    `${removedIds.length} removed. ver=${libraryVer} builder=v${CATALOG_BUILDER_VERSION}`,
  ].join(" ");
  console.log(`[gameCatalog] ${msg}`);
  if (unknownRawMaterialIds.length > 0) {
    console.log(`[gameCatalog] Unknown raw material IDs needing classification (${unknownRawMaterialIds.length}):\n` +
      unknownRawMaterialIds.join("\n"));
  }
  return { built: true, itemCount: total, message: msg, breakdown };
}

// ---------------------------------------------------------------------------
// queryCatalog — for debug route
// ---------------------------------------------------------------------------

export interface CatalogFilter {
  itemId?: string;
  industry?: string;
  tier?: number;
  skill?: string;
  category?: string;
  limit?: number;
}

export function queryCatalog(filter: CatalogFilter): CatalogRow[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filter.itemId) {
    conditions.push("item_id = ?");
    params.push(filter.itemId);
  }
  if (filter.industry) {
    conditions.push("industry = ?");
    params.push(filter.industry);
  }
  if (filter.tier !== undefined) {
    conditions.push("tier = ?");
    params.push(filter.tier);
  }
  if (filter.skill) {
    conditions.push("skill = ?");
    params.push(filter.skill);
  }
  if (filter.category) {
    conditions.push("category = ?");
    params.push(filter.category);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filter.limit && filter.limit > 0 ? `LIMIT ${filter.limit}` : "LIMIT 100";
  const stmt = db.prepare<typeof params>(`SELECT * FROM game_catalog ${where} ORDER BY display_name ASC ${limit}`);
  return stmt.all(...params) as CatalogRow[];
}

// ---------------------------------------------------------------------------
// fuzzyResolveName — DL ≤ 2 fuzzy match against catalog display names.
// Returns best match item_id or null when no match is within threshold.
// ---------------------------------------------------------------------------

export interface FuzzyMatch {
  itemId: string;
  displayName: string;
  distance: number;
}

export function fuzzyResolveName(query: string, maxDist = 2): FuzzyMatch | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;

  // Try word-by-word: score based on best matching word in display name
  const qWords = q.split(/\s+/);
  const rows = listCatalogRows();

  let best: FuzzyMatch | null = null;

  for (const row of rows) {
    const name = row.display_name.toLowerCase();
    // Full name distance
    const fullDist = damerauLevenshtein(q, name);
    let minDist = fullDist;

    // Word-level: match each query word against each name word
    const nameWords = name.split(/\s+/);
    let wordDist = 0;
    for (const qw of qWords) {
      let best_w = Infinity;
      for (const nw of nameWords) {
        const d = damerauLevenshtein(qw, nw);
        if (d < best_w) best_w = d;
      }
      wordDist += best_w;
    }
    minDist = Math.min(minDist, wordDist);

    if (minDist <= maxDist) {
      if (!best || minDist < best.distance) {
        best = { itemId: row.item_id, displayName: row.display_name, distance: minDist };
      }
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// findRecipesUsingItem — scan catalog for recipes that consume a given itemId.
// ---------------------------------------------------------------------------

export function findRecipesUsingItem(itemId: string): Array<{ consumerName: string; qty: number }> {
  const rows = listCatalogRows();
  const results: Array<{ consumerName: string; qty: number }> = [];
  const seen = new Set<string>();

  for (const row of rows) {
    if (seen.has(row.display_name)) continue;

    const checkInputs = (inputs: Array<{ id: string; name: string; qty: number }>) => {
      const m = inputs.find(i => i.id === itemId);
      if (m && !seen.has(row.display_name)) {
        results.push({ consumerName: row.display_name, qty: m.qty });
        seen.add(row.display_name);
      }
    };

    if (row.recipe_inputs) {
      try { checkInputs(JSON.parse(row.recipe_inputs)); } catch { /* skip */ }
    }
    if (row.all_recipes && !seen.has(row.display_name)) {
      try {
        const allRecipes: Array<{ inputs: Array<{id: string; name: string; qty: number}> }> = JSON.parse(row.all_recipes);
        for (const r of allRecipes) if (r.inputs) checkInputs(r.inputs);
      } catch { /* skip */ }
    }
  }

  return results.sort((a, b) => a.consumerName.localeCompare(b.consumerName));
}

// ---------------------------------------------------------------------------
// generateFastAnswer — template answer for catalog fact questions
// ---------------------------------------------------------------------------

const SKILL_DISPLAY_NAMES: Record<string, string> = {
  exploration: "Exploration",
  petcare: "Animal Care",
  farming: "Farming",
  mining: "Mining",
  forestry: "Forestry",
  crafting: "Crafting",
};

function skillDisplayName(skill: string | null): string {
  if (!skill) return "skill";
  return SKILL_DISPLAY_NAMES[skill] ?? (skill.charAt(0).toUpperCase() + skill.slice(1));
}

function formatGrowMinutes(minutes: number): string {
  const totalMin = Math.floor(minutes);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `about ${h}h ${m}m` : `about ${h}h`;
  }
  return `about ${totalMin} min`;
}

export function generateFastAnswer(
  row: CatalogRow,
  question: string,
  playerSkills?: Record<string, number>,
  playerInventory?: Record<string, number>,
): string | null {
  const q = question.toLowerCase();
  const name = row.display_name;

  // retired recipe — no crafting data available
  if (row.category === "retired") {
    return `${name} isn't craftable at the moment — it was an old recipe that may come back.`;
  }

  // grow time question
  if (/\b(?:how\s+long|grow\s+time|time\s+to\s+grow|growth\s+time)\b/.test(q) && row.grow_time_minutes !== null) {
    const time = formatGrowMinutes(row.grow_time_minutes);
    let answer = `${name} takes ${time} to grow.`;
    if (row.seed_name) answer += ` Plant it using ${row.seed_name}.`;
    if (row.harvest_xp) answer += ` Harvesting gives ${row.harvest_xp} XP.`;
    return answer;
  }

  // level requirement question
  if (/\b(?:what\s+level|level\s+(?:do|required|need)|require|unlock)\b/.test(q) && row.level_required !== null) {
    const skillLabel = skillDisplayName(row.skill);
    let answer = `${name} requires ${skillLabel} level ${row.level_required}.`;
    if (row.category === "crop" && row.tool_min_tier) {
      answer += ` You also need Farming shears tier ${row.tool_min_tier}+.`;
    }
    return answer;
  }

  // recipe question
  if (/\b(?:recipe|ingredient|craft|how\s+to\s+make|how\s+to\s+craft)\b/.test(q) && (row.recipe_inputs || row.all_recipes)) {
    // Multiple recipes — list each one
    if (row.all_recipes) {
      const recipes: Array<{
        achId: string; station: string | null; skill: string | null;
        levelRequired: number | null; inputs: Array<{id: string; name: string; qty: number}>;
        outputQty: number; craftTimeMinutes: number | null; energy: number | null;
        craftXp: number | null; isEvent: number;
      }> = JSON.parse(row.all_recipes);
      const parts = recipes.map((r, i) => {
        const ingStr = r.inputs.map(inp => `${inp.qty}x ${inp.name}`).join(", ");
        let s = `Recipe ${i + 1}: ${ingStr} → ${r.outputQty}x ${name}`;
        if (r.station) s += ` (${r.station})`;
        if (r.levelRequired) s += `, requires level ${r.levelRequired}`;
        if (r.energy) s += `, ${r.energy} energy`;
        if (r.craftXp) s += `, ${r.craftXp} XP`;
        if (r.isEvent) s += ` [event/seasonal]`;
        return s;
      });
      return `${name} has ${recipes.length} recipes:\n${parts.join("\n")}`;
    }
    // Single recipe
    if (row.recipe_inputs) {
      const inputs: Array<{ id: string; name: string; qty: number }> = JSON.parse(row.recipe_inputs);
      const ingStr = inputs.map(i => `${i.qty}x ${i.name}`).join(", ");
      let answer = `To craft ${name} you need: ${ingStr}.`;
      if (row.recipe_station) answer += ` (station: ${row.recipe_station})`;
      if (row.skill && row.level_required) {
        answer += ` Requires ${row.skill} level ${row.level_required}.`;
      }
      if (row.craft_energy) answer += ` Costs ${row.craft_energy} energy.`;
      if (row.craft_xp) answer += ` Gives ${row.craft_xp} XP.`;
      return answer;
    }
  }

  // tool requirement
  if (/\b(?:tool|shears|pickaxe|axe)\b/.test(q) && row.tool_type && row.tool_min_tier) {
    return `${name} requires a ${row.tool_type} tier ${row.tool_min_tier} or better.`;
  }

  // seed question
  if (/\b(?:seed|plant|how\s+to\s+farm|how\s+to\s+grow)\b/.test(q) && row.seed_name) {
    let answer = `${name} is grown by planting ${row.seed_name}.`;
    if (row.grow_time_minutes !== null) answer += ` It takes ${formatGrowMinutes(row.grow_time_minutes)} to grow.`;
    if (row.harvest_xp) answer += ` Gives ${row.harvest_xp} XP per harvest.`;
    return answer;
  }

  // "where do I get / how do I get / where can I find" — resource access
  if (/\b(?:where\s+(?:do\s+i\s+)?(?:get|find|obtain|buy)|how\s+(?:do\s+i\s+)?(?:get|obtain|find)|where\s+can\s+i\s+(?:get|find|obtain|buy)|how\s+to\s+(?:get|obtain|find))\b/.test(q)) {
    return generateSourceAnswer(row, playerSkills, playerInventory);
  }

  // Bare item query — return full fact sheet: how obtained + used in.
  const obtainedBy = generateSourceAnswer(row, playerSkills, playerInventory);
  const usedIn = findRecipesUsingItem(row.item_id);
  let factSheet = obtainedBy;
  if (usedIn.length > 0) {
    factSheet += "\nUsed in: " + usedIn.map(u => `${u.consumerName} (${u.qty} each)`).join(", ") + ".";
  } else {
    factSheet += "\nUsed in: not found in any known crafting recipes.";
  }
  return factSheet;
}

function bestToolTierInInventory(
  toolType: string,
  playerInventory: Record<string, number>,
): number | null {
  const prefix = toolType === "pickaxe" ? "itm_pickaxe" : toolType === "axe" ? "itm_axe" : toolType === "shears" ? "itm_shears" : null;
  if (!prefix) return null;
  let best: number | null = null;
  for (const [id, qty] of Object.entries(playerInventory)) {
    if (qty <= 0 || !id.startsWith(prefix)) continue;
    const t = tierFromId(id);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

function generateSourceAnswer(
  row: CatalogRow,
  playerSkills?: Record<string, number>,
  playerInventory?: Record<string, number>,
): string {
  const name = row.display_name ?? row.item_id;
  const skill = row.skill;
  const levelRequired = row.level_required;
  const toolType = row.tool_type;
  const toolTier = row.tool_min_tier;
  const category = row.category;

  if (category === "crafted") {
    if (row.recipe_inputs) {
      try {
        const inputs: Array<{ id: string; name: string; qty: number }> = JSON.parse(row.recipe_inputs);
        const ingStr = inputs.map(i => `${i.qty}x ${i.name}`).join(", ");
        let answer = `${name} is crafted — you make it using: ${ingStr}.`;
        if (row.recipe_station) answer += ` Station: ${row.recipe_station}.`;
        if (skill && levelRequired) {
          const playerLv = playerSkills ? (playerSkills[skill.toLowerCase()] ?? 0) : 0;
          if (playerLv < levelRequired) {
            answer += ` You need ${skillDisplayName(skill)} level ${levelRequired} to craft it (you're at ${playerLv}).`;
          } else {
            answer += ` You have the required ${skillDisplayName(skill)} level.`;
          }
        }
        return answer;
      } catch {
        // fall through
      }
    }
    return `${name} is a crafted item — check your crafting station for the recipe.`;
  }

  if (category === "crop") {
    const playerFarmingLv = playerSkills ? (playerSkills["farming"] ?? 0) : 0;
    const canFarm = levelRequired === null || levelRequired === 0 || playerFarmingLv >= levelRequired;
    const landLabel = row.land_type ? ` on ${LAND_TYPE_LABELS[row.land_type] ?? row.land_type.toLowerCase()}` : "";
    let answer: string;
    if (!canFarm && levelRequired !== null) {
      answer = `You can't farm ${name} yet — you need Farming level ${levelRequired} (you're at ${playerFarmingLv}).`;
    } else {
      answer = `${name} is a farm crop${landLabel}.`;
    }
    if (row.seed_name) {
      answer += ` Plant ${row.seed_name}`;
      if (row.grow_time_minutes !== null) answer += `, grows in ${formatGrowMinutes(row.grow_time_minutes)}`;
      answer += ".";
    }
    if (toolType && toolTier) {
      answer += ` Needs a ${toolType} tier ${toolTier}+.`;
    }
    return answer;
  }

  if (category === null) {
    return `I don't know where ${name} comes from yet — I haven't classified this item.`;
  }

  if (category === "gathered") {
    const industry = row.industry;
    let verb: string;
    if (industry === "mine")                 verb = "mined";
    else if (industry === "forestry")        verb = "chopped from trees";
    else if (industry === "fishing")         verb = "caught by fishing";
    else if (industry === "animal product")  verb = "obtained from an animal on your land";
    else                                     verb = "gathered";

    const landLabel = row.land_type ? ` on ${LAND_TYPE_LABELS[row.land_type] ?? row.land_type.toLowerCase()}` : "";
    const tierPart = row.tier ? ` (tier ${row.tier})` : "";
    let answer = `${name} is ${verb}${landLabel}${tierPart}.`;

    if (levelRequired !== null && levelRequired > 0 && skill) {
      const playerLv = playerSkills ? (playerSkills[skill.toLowerCase()] ?? 0) : 0;
      if (playerLv < levelRequired) {
        answer += ` You can't gather it yet — needs ${skillDisplayName(skill)} level ${levelRequired}, you're at ${playerLv}.`;
      } else {
        answer += ` Needs ${skillDisplayName(skill)} level ${levelRequired} — you're at ${playerSkills![skill.toLowerCase()]} ✓.`;
      }
    } else if (skill && (!levelRequired || levelRequired === 0)) {
      answer += ` No level requirement.`;
    }

    if (toolType && toolTier && toolTier <= 1) {
      answer += ` Any ${toolType} works.`;
    } else if (toolType && toolTier) {
      answer += ` Needs a tier ${toolTier}+ ${toolType}.`;
    } else if (toolType) {
      answer += ` Requires a ${toolType}.`;
    }

    // Report the player's best matching tool from their backpack
    if (toolType && playerInventory) {
      const bestTier = bestToolTierInInventory(toolType, playerInventory);
      if (bestTier !== null) {
        if (toolTier && bestTier >= toolTier) {
          answer += ` You have a tier ${bestTier} ${toolType} in your backpack ✓.`;
        } else if (toolTier) {
          answer += ` Your best ${toolType} is tier ${bestTier} — you need tier ${toolTier}+.`;
        } else {
          answer += ` You have a tier ${bestTier} ${toolType} in your backpack.`;
        }
      } else if (toolType) {
        answer += ` No ${toolType} in your backpack.`;
      }
    }

    return answer;
  }

  return `${name} is obtained by ${category}.`;
}
