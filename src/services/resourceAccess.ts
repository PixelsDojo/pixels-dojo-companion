import { fetchItems, fetchAchievements, fetchEntities } from "./gameLibrary";
import { buildHarvestMap } from "./itemLookup";

// ---------------------------------------------------------------------------
// Tier ladder — fallback when item has no explicit level requirement
// ---------------------------------------------------------------------------

// T1 = 0–19, T2 = 20–39, T3 = 40–59, T4 = 60–79, T5 = 80–100
const TIER_MIN_LEVEL = [0, 0, 20, 40, 60, 80]; // index is tier number

function tierFromLevel(level: number): number {
  for (let t = 5; t >= 1; t--) {
    if (level >= TIER_MIN_LEVEL[t]) return t;
  }
  return 1;
}

function levelForTier(tier: number): number {
  return TIER_MIN_LEVEL[Math.max(1, Math.min(5, tier))] ?? 0;
}

// ---------------------------------------------------------------------------
// Tier extraction from an entity/item ID  (e.g. "ent_copper_rock_t2" → 2)
// ---------------------------------------------------------------------------

function tierFromId(id: string): number | null {
  const m = id.match(/_t(\d+)(?:_|$)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Tool-type patterns — pickaxe / axe / shears — data-driven regex on item ID.
// ---------------------------------------------------------------------------

const TOOL_SKILL_PATTERNS: Array<{ regex: RegExp; skill: string }> = [
  { regex: /^itm_pickaxe/i, skill: "mining" },
  { regex: /^itm_axe/i,     skill: "forestry" },
  { regex: /^itm_shears/i,  skill: "farming" },
];

// ---------------------------------------------------------------------------
// GATHERING_FAMILIES — prefix-based fallback for raw gathered resources that
// carry no requirements.levels and have no craftable recipe.
// Drop tables do not exist in oss_pixels_server; yields are server-side
// PixScript only. This constant encodes the family → skill mapping.
// Add new families here as a single line each.
// ---------------------------------------------------------------------------

const GATHERING_FAMILIES: Array<{
  regex: RegExp;
  skill: "mining" | "forestry";
  obtainMethod: "mined" | "chopped";
}> = [
  { regex: /^itm_roughstone_|^itm_silicates_|^itm_metalore_|^itm_coal_/, skill: "mining",   obtainMethod: "mined"   },
  { regex: /^itm_woodlog_/,                                               skill: "forestry", obtainMethod: "chopped" },
];

function matchGatheringFamily(
  itemId: string,
): { skill: "mining" | "forestry"; obtainMethod: "mined" | "chopped" } | null {
  for (const fam of GATHERING_FAMILIES) {
    if (fam.regex.test(itemId)) return { skill: fam.skill, obtainMethod: fam.obtainMethod };
  }
  return null;
}

function toolSkillFromId(itemId: string): string | null {
  for (const { regex, skill } of TOOL_SKILL_PATTERNS) {
    if (regex.test(itemId)) return skill;
  }
  return null;
}

// ---------------------------------------------------------------------------
// buildEntityLabelToSkill
// ---------------------------------------------------------------------------

function buildEntityLabelToSkill(allItems: Record<string, any>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const [id, item] of Object.entries(allItems)) {
    const skill = toolSkillFromId(id);
    if (!skill) continue;
    const labels: unknown[] = (item as any)?.useTargets?.entityLabels ?? [];
    for (const lbl of labels) {
      if (typeof lbl === "string" && lbl) map[lbl] = skill;
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// bestToolInInventory
// ---------------------------------------------------------------------------

function bestToolInInventory(
  skill: string,
  inventory: Record<string, number>,
  allItems: Record<string, any>,
  nameMap: Record<string, string> = {},
): { itemId: string; itemName: string; tier: number } | null {
  let best: { itemId: string; itemName: string; tier: number } | null = null;
  for (const [itemId, qty] of Object.entries(inventory)) {
    if (qty <= 0) continue;
    if (toolSkillFromId(itemId) !== skill) continue;
    const item = allItems[itemId];
    if (!item) continue;
    const tier: number = typeof item.tier === "number" && item.tier > 0 ? item.tier : 1;
    if (!best || tier > best.tier) {
      // item.name is stripped by clientifyItem; use nameMap first.
      const itemName = nameMap[itemId] ?? item.name ?? item.label ?? itemId;
      best = { itemId, itemName, tier };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// findToolRecipeLine
// ---------------------------------------------------------------------------

function findToolRecipeLine(
  skill: string,
  requiredTier: number,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
  nameMap: Record<string, string> = {},
): string | null {
  for (const [itemId, item] of Object.entries(allItems)) {
    if (toolSkillFromId(itemId) !== skill) continue;
    const itemTier: number = typeof item.tier === "number" && item.tier > 0 ? item.tier : 1;
    if (itemTier !== requiredTier) continue;
    const itemName: string = nameMap[itemId] ?? item.name ?? item.label ?? itemId;
    const achKey = itemId.startsWith("itm_") ? "ach_" + itemId.slice(4) : null;
    const craftable =
      (allAchievements[itemId] as any)?.craftable ??
      (achKey ? (allAchievements[achKey] as any)?.craftable : null) ??
      Object.values(allAchievements).find(
        (a: any) => a?.craftable?.result?.items?.some((ri: any) => ri?.id === itemId),
      )?.craftable ?? null;
    if (!craftable) continue;
    const reqs: any[] = craftable.requiredItems ?? [];
    if (reqs.length === 0) continue;
    const ingStr = reqs
      .map((ri: any) => {
        const ingName = nameMap[ri?.id] ?? allItems[ri?.id]?.name ?? allItems[ri?.id]?.label ?? ri?.id ?? "?";
        return `${ri?.quantity ?? 1}x ${ingName}`;
      })
      .join(", ");
    return `${itemName} (${ingStr})`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// findSourceEntity — farming / mining / forestry entity lookup
// ---------------------------------------------------------------------------

interface CropData {
  seedId: string;
  seedTier: number | null;
  growTime: number | null;
  harvestXP: number | null;
  harvestNRG: number | null;
  plantEnergy: number | null; // absolute value of onUse.energy.value (cost per planting)
  gatheringEnergy: number | null; // plantEnergy + harvestNRG
}

interface SourceEntityResult {
  entityId: string;
  entity: any;
  skill: string | null;
  tier: number | null;
  cropData?: CropData;
}

function findSourceEntity(
  itemId: string,
  allItems: Record<string, any>,
  allEntities: Record<string, any>,
  harvestMap: Record<string, string[]>,
): SourceEntityResult | null {
  // Farming: look for a seed whose onUse.plant.fruit === itemId.
  // BUG NOTE: the entity for the crop is at onUse.plant.entity, NOT onUse.placeEntity.entity.
  // onUse.placeEntity is a separate feature (for items that place a non-crop entity on the map).
  for (const [seedId, seed] of Object.entries(allItems)) {
    if ((seed as any)?.onUse?.plant?.fruit !== itemId) continue;
    const plant = (seed as any).onUse.plant;
    const entityId: string | undefined = plant.entity; // correct path: onUse.plant.entity
    const seedTier: number | null =
      typeof (seed as any).tier === "number" && (seed as any).tier > 0 ? (seed as any).tier : null;
    const growTime: number | null =
      typeof plant.growTime === "number" ? plant.growTime : null;
    const harvestXP: number | null =
      typeof plant.harvestXP === "number" ? plant.harvestXP : null;
    const harvestNRG: number | null =
      typeof plant.harvestNRG === "number" ? plant.harvestNRG : null;
    const rawPlantEnergy = (seed as any)?.onUse?.energy?.value;
    const plantEnergy: number | null =
      typeof rawPlantEnergy === "number" ? Math.abs(rawPlantEnergy) : null;
    const gatheringEnergy: number | null =
      plantEnergy !== null && harvestNRG !== null ? plantEnergy + harvestNRG : null;

    const cropData: CropData = { seedId, seedTier, growTime, harvestXP, harvestNRG, plantEnergy, gatheringEnergy };

    if (!entityId) {
      // Entity path absent (some seeds don't store an entity reference), but crop data is valid.
      return { entityId: "", entity: null, skill: "farming", tier: seedTier, cropData };
    }
    const entity = allEntities[entityId];
    const tier = seedTier ?? tierFromId(entityId);
    return { entityId, entity, skill: "farming", tier, cropData };
  }

  // Mining / Forestry: keyword match between itemId and entity IDs
  const rawKeywords = itemId
    .toLowerCase()
    .replace(/^itm_/, "")
    .split(/_/)
    .filter((w) => w.length >= 3 && !/^t\d+$/.test(w));

  if (rawKeywords.length === 0) return null;

  let bestId: string | null = null;
  let bestScore = 0;

  for (const entityId of Object.keys(allEntities)) {
    const parts = entityId
      .toLowerCase()
      .replace(/^ent_/, "")
      .split(/_/)
      .filter((w) => !/^t\d+$/.test(w));
    const score = rawKeywords.filter((kw) => parts.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestId = entityId;
    }
  }

  if (!bestId || bestScore === 0) return null;

  const entity = allEntities[bestId];
  const tier = tierFromId(bestId);
  return { entityId: bestId, entity, skill: null, tier };
}

// ---------------------------------------------------------------------------
// Public result type
// ---------------------------------------------------------------------------

export interface ResourceAccessResult {
  obtainMethod: "mined" | "chopped" | "harvested" | "crafted" | "unknown";
  skill: string | null;
  sourceTier: number | null;
  levelRequired: number | null;
  playerLevel: number | null;
  skillUnlocked: boolean | null;
  bestTool: { itemId: string; itemName: string; tier: number } | null;
  toolSufficient: boolean | null;
  toolRecipeHint: string | null;
  summary: string;
  // Crop-specific fields (only set when obtainMethod === "harvested" via plant seed):
  seedId: string | null;
  seedName: string | null;
  growTime: number | null;
  // growTime is in minutes (confirmed in-game: Popberry growTime=6 = 6 minutes).
  harvestXP: number | null;
  harvestNRG: number | null;
  plantEnergy: number | null;
  gatheringEnergy: number | null; // plantEnergy + harvestNRG — total energy per harvest cycle
}

// ---------------------------------------------------------------------------
// formatGrowMinutes — format a growTime value (in minutes) as a human string.
// ---------------------------------------------------------------------------

function formatGrowMinutes(minutes: number): string {
  const totalMin = Math.floor(minutes);
  if (totalMin >= 60) {
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m > 0 ? `about ${h}h ${m}m` : `about ${h}h`;
  }
  return `about ${totalMin} min`;
}

// ---------------------------------------------------------------------------
// assembleResult — shared helper: tool check + summary string.
// Called by both the item-requirements path and the entity path.
// ---------------------------------------------------------------------------

function assembleResult(
  obtainMethod: ResourceAccessResult["obtainMethod"],
  skill: string | null,
  sourceTier: number | null,
  levelRequired: number | null,
  skillsMap: Record<string, number>,
  inventory: Record<string, number>,
  allItems: Record<string, any>,
  allAchievements: Record<string, any>,
  nameMap: Record<string, string> = {},
): ResourceAccessResult {
  const playerLevel = skill ? (skillsMap[skill] ?? null) : null;
  const skillUnlocked =
    levelRequired !== null && playerLevel !== null ? playerLevel >= levelRequired : null;

  let bestTool: ResourceAccessResult["bestTool"] = null;
  let toolSufficient: boolean | null = null;
  let toolRecipeHint: string | null = null;

  if (skill && skill !== "unknown" && sourceTier !== null) {
    bestTool = bestToolInInventory(skill, inventory, allItems, nameMap);
    if (bestTool) {
      toolSufficient = bestTool.tier >= sourceTier;
      if (!toolSufficient) {
        toolRecipeHint = findToolRecipeLine(skill, sourceTier, allItems, allAchievements, nameMap);
      }
    } else {
      toolSufficient = false;
      if (sourceTier <= 1) {
        toolRecipeHint = `No ${capitalize(skill)} tool in inventory — tier 1 tools can be purchased.`;
      } else {
        const recipe = findToolRecipeLine(skill, sourceTier, allItems, allAchievements, nameMap);
        toolRecipeHint = recipe
          ? `No ${capitalize(skill)} tool in inventory — tier ${sourceTier} must be crafted: ${recipe}`
          : `No ${capitalize(skill)} tool in inventory — tier ${sourceTier} required.`;
      }
    }
  }

  const parts: string[] = [];
  const tierLabel = sourceTier !== null ? ` (tier ${sourceTier})` : "";
  parts.push(`Obtained by: ${obtainMethod}${tierLabel}`);

  if (skill) {
    const skillDisplay = capitalize(skill);
    if (levelRequired !== null && levelRequired > 0) {
      const levelNote =
        playerLevel !== null
          ? ` ${playerLevel} — ${skillUnlocked ? "unlocked ✓" : `need level ${levelRequired}, you have ${playerLevel} ✗`}`
          : ` — level ${levelRequired} required`;
      parts.push(`Skill: ${skillDisplay}${levelNote}`);
    } else if (playerLevel !== null) {
      parts.push(`Skill: ${skillDisplay} ${playerLevel} — unlocked ✓ (no level requirement)`);
    } else {
      parts.push(`Skill: ${skillDisplay}`);
    }
  }

  if (skill && sourceTier !== null) {
    if (bestTool) {
      const toolNote = toolSufficient
        ? `needs ${capitalize(skill)} tool tier ${sourceTier}+ — you have tier ${bestTool.tier} ✓`
        : `needs ${capitalize(skill)} tool tier ${sourceTier}+ — you have tier ${bestTool.tier} ✗`;
      parts.push(`Tool: ${toolNote}`);
      if (!toolSufficient && toolRecipeHint) {
        parts.push(`Tier ${sourceTier} tool recipe: ${toolRecipeHint}`);
      }
    } else {
      parts.push(`Tool: needs ${capitalize(skill)} tool tier ${sourceTier}+, none in inventory ✗`);
      if (toolRecipeHint) {
        parts.push(`Tier ${sourceTier} tool recipe: ${toolRecipeHint}`);
      }
    }
  }

  return {
    obtainMethod, skill, sourceTier, levelRequired,
    playerLevel, skillUnlocked, bestTool, toolSufficient, toolRecipeHint,
    summary: parts.join(". "),
    // Crop fields not applicable on this path:
    seedId: null, seedName: null, growTime: null,
    harvestXP: null, harvestNRG: null, plantEnergy: null, gatheringEnergy: null,
  };
}

// ---------------------------------------------------------------------------
// computeResourceAccess — main export
// ---------------------------------------------------------------------------

export async function computeResourceAccess(
  itemId: string,
  inventory: Record<string, number>,
  skills: Record<string, number>,
  nameMap: Record<string, string> = {},
): Promise<ResourceAccessResult | null> {
  let allItems: Record<string, any>;
  let allAchievements: Record<string, any>;
  let allEntities: Record<string, any>;
  try {
    [allItems, allAchievements, allEntities] = await Promise.all([
      fetchItems() as Promise<Record<string, any>>,
      fetchAchievements() as Promise<Record<string, any>>,
      fetchEntities() as Promise<Record<string, any>>,
    ]);
  } catch {
    return null;
  }

  const harvestMap = buildHarvestMap(allItems);
  const labelToSkill = buildEntityLabelToSkill(allItems);

  // -- 0. Item's own requirements field (primary source for raw gathered resources).
  // requirements.levels[].levelType → skill, requirements.levels[].level → levelRequired,
  // item.tier → sourceTier. Only use the tier ladder when this data is absent.
  const item = allItems[itemId];
  if (item?.requirements?.levels?.length > 0) {
    const req = item.requirements.levels[0];
    const skill: string | null =
      typeof req.levelType === "string" ? req.levelType.toLowerCase() : null;
    const levelRequired: number | null =
      typeof req.level === "number" ? req.level : null;
    const sourceTier: number | null =
      typeof item.tier === "number" && item.tier > 0 ? item.tier : null;
    const obtainMethod: "mined" | "chopped" | "harvested" | null =
      skill === "mining"   ? "mined"     :
      skill === "forestry" ? "chopped"   :
      skill === "farming"  ? "harvested" : null;
    // Only early-return for known gather skills. Crafted items (cooking, crafting…)
    // may also carry requirements.levels — fall through so Step 1 handles them.
    if (obtainMethod !== null) {
      return assembleResult(obtainMethod, skill, sourceTier, levelRequired, skills, inventory, allItems, allAchievements, nameMap);
    }
  }

  // -- 1. Craftable recipe check.
  // Three lookup strategies in order:
  //   a) Direct: allAchievements[itemId] (works when keyed by item ID)
  //   b) Conventional key: ach_ + stripped item ID (handles items whose achievement is keyed
  //      as ach_grumpkingspicedlatte for itm_grumpkingspicedlatte but result.items is absent)
  //   c) Scan: find any achievement whose result.items contains itemId
  const achKey = itemId.startsWith("itm_") ? "ach_" + itemId.slice(4) : null;
  const craftable =
    (allAchievements[itemId] as any)?.craftable ??
    (achKey ? (allAchievements[achKey] as any)?.craftable : null) ??
    Object.values(allAchievements).find(
      (a: any) => a?.craftable?.result?.items?.some((ri: any) => ri?.id === itemId),
    )?.craftable ?? null;

  if (craftable) {
    const skill: string | null =
      typeof craftable.requiredSkill === "string" ? craftable.requiredSkill.toLowerCase() : null;
    const levelRequired: number | null =
      typeof craftable.requiredLevel === "number" ? craftable.requiredLevel : null;
    const playerLevel = skill ? (skills[skill] ?? null) : null;
    const skillUnlocked =
      levelRequired !== null && playerLevel !== null ? playerLevel >= levelRequired : null;

    const parts: string[] = ["Obtained by: crafting"];
    const stationType = typeof craftable.type === "string" ? craftable.type : null;
    if (stationType) parts.push(`Station: ${stationType}`);
    if (skill && levelRequired !== null) {
      parts.push(
        `Skill: ${capitalize(skill)} ${levelRequired} required${
          playerLevel !== null
            ? ` (you have ${playerLevel}) — ${skillUnlocked ? "unlocked ✓" : "locked ✗"}`
            : ""
        }`,
      );
    }
    const reqs: any[] = craftable.requiredItems ?? [];
    if (reqs.length > 0) {
      const ingStr = reqs
        .map((ri: any) => {
          const ingId: string = ri?.id ?? "";
          const ingName = nameMap[ingId] ?? allItems[ingId]?.name ?? allItems[ingId]?.label ?? ingId;
          return `${ri?.quantity ?? 1}x ${ingName}`;
        })
        .join(", ");
      parts.push(`Ingredients: ${ingStr}`);
    }

    return {
      obtainMethod: "crafted",
      skill,
      sourceTier: null,
      levelRequired,
      playerLevel,
      skillUnlocked,
      bestTool: null,
      toolSufficient: null,
      toolRecipeHint: null,
      summary: parts.join(". "),
      seedId: null, seedName: null, growTime: null,
      harvestXP: null, harvestNRG: null, plantEnergy: null, gatheringEnergy: null,
    };
  }

  // -- 1.5. Gathering family check (raw resources with no requirements and no recipe).
  // Drop/yield tables are absent from oss_pixels_server; use GATHERING_FAMILIES as the
  // static fallback. Source tier comes from item.tier; level from the tier ladder.
  const familyMatch = matchGatheringFamily(itemId);
  if (familyMatch) {
    const sourceTier = typeof item?.tier === "number" && item.tier > 0 ? item.tier : null;
    const levelRequired = sourceTier !== null ? levelForTier(sourceTier) : 0;
    return assembleResult(
      familyMatch.obtainMethod, familyMatch.skill, sourceTier, levelRequired,
      skills, inventory, allItems, allAchievements, nameMap,
    );
  }

  // -- 2. Find source entity (farming / mining / forestry).
  const src = findSourceEntity(itemId, allItems, allEntities, harvestMap);

  if (!src) {
    return {
      obtainMethod: "unknown",
      skill: null,
      sourceTier: null,
      levelRequired: null,
      playerLevel: null,
      skillUnlocked: null,
      bestTool: null,
      toolSufficient: null,
      toolRecipeHint: null,
      summary: "Source: not found in catalog — item may be obtained via purchase, drop, or an event.",
      seedId: null, seedName: null, growTime: null,
      harvestXP: null, harvestNRG: null, plantEnergy: null, gatheringEnergy: null,
    };
  }

  // Determine skill from entity labels when not already set.
  let skill = src.skill;
  if (!skill) {
    const entityLabels: string[] = src.entity?.labels ?? [];
    for (const lbl of entityLabels) {
      const s = labelToSkill[lbl];
      if (s) { skill = s; break; }
    }
  }

  // --- Farming / crop path ---
  if (skill === "farming" && src.cropData) {
    const cd = src.cropData;
    const seedItem = allItems[cd.seedId];
    // Level: explicit seed requirement first, then tier ladder.
    const levelRequired: number | null =
      seedItem?.requirements?.levels?.[0]?.level ??
      (cd.seedTier !== null ? levelForTier(cd.seedTier) : null);
    const sourceTier = cd.seedTier;
    const playerLevel = skills["farming"] ?? null;
    const skillUnlocked =
      levelRequired !== null && playerLevel !== null ? playerLevel >= levelRequired : null;
    const seedName = nameMap[cd.seedId] ?? cd.seedId;

    const bestTool = bestToolInInventory("farming", inventory, allItems, nameMap);
    let toolSufficient: boolean | null = null;
    let toolRecipeHint: string | null = null;
    if (sourceTier !== null) {
      if (bestTool) {
        toolSufficient = bestTool.tier >= sourceTier;
        if (!toolSufficient) {
          toolRecipeHint = findToolRecipeLine("farming", sourceTier, allItems, allAchievements, nameMap);
        }
      } else {
        toolSufficient = false;
        const recipe = findToolRecipeLine("farming", sourceTier, allItems, allAchievements, nameMap);
        toolRecipeHint = recipe
          ? `No Farming tool in inventory — tier ${sourceTier} shears must be crafted: ${recipe}`
          : `No Farming tool in inventory — tier ${sourceTier} shears required.`;
      }
    }

    const parts: string[] = [];
    const tierLabel = sourceTier !== null ? ` (tier ${sourceTier})` : "";
    parts.push(`Obtained by: harvested (Farming)${tierLabel}`);
    parts.push(`Plant: ${seedName}`);

    if (levelRequired !== null && levelRequired > 0) {
      const levelNote =
        playerLevel !== null
          ? ` ${playerLevel} — ${skillUnlocked ? "unlocked ✓" : `need level ${levelRequired}, you have ${playerLevel} ✗`}`
          : ` — level ${levelRequired} required`;
      parts.push(`Skill: Farming${levelNote}`);
    } else if (playerLevel !== null) {
      parts.push(`Skill: Farming ${playerLevel} — unlocked ✓ (no level requirement)`);
    } else {
      parts.push(`Skill: Farming`);
    }

    if (bestTool) {
      const toolNote = toolSufficient
        ? `needs Farming tool tier ${sourceTier}+ — you have tier ${bestTool.tier} ✓`
        : `needs Farming tool tier ${sourceTier}+ — you have tier ${bestTool.tier} ✗`;
      parts.push(`Tool: ${toolNote}`);
      if (!toolSufficient && toolRecipeHint) parts.push(`Tier ${sourceTier} tool recipe: ${toolRecipeHint}`);
    } else {
      parts.push(`Tool: needs Farming tool tier ${sourceTier}+, none in inventory ✗`);
      if (toolRecipeHint) parts.push(`Tier ${sourceTier} tool recipe: ${toolRecipeHint}`);
    }

    const growParts: string[] = [];
    if (cd.growTime !== null) growParts.push(`grows in ${formatGrowMinutes(cd.growTime)}`);
    if (cd.plantEnergy !== null) growParts.push(`${cd.plantEnergy} energy to plant`);
    if (cd.harvestNRG !== null) growParts.push(`${cd.harvestNRG} energy to harvest`);
    if (cd.harvestXP !== null) growParts.push(`gives ${cd.harvestXP} XP per harvest`);
    if (growParts.length > 0) parts.push(growParts.join(", "));

    return {
      obtainMethod: "harvested",
      skill: "farming",
      sourceTier,
      levelRequired,
      playerLevel,
      skillUnlocked,
      bestTool,
      toolSufficient,
      toolRecipeHint,
      summary: parts.join(". "),
      seedId: cd.seedId,
      seedName,
      growTime: cd.growTime,
      harvestXP: cd.harvestXP,
      harvestNRG: cd.harvestNRG,
      plantEnergy: cd.plantEnergy,
      gatheringEnergy: cd.gatheringEnergy,
    };
  }

  const sourceTier = src.tier;
  // Use tier ladder for level when item has no explicit level requirement (already checked above).
  const levelRequired = sourceTier !== null ? levelForTier(sourceTier) : null;

  const obtainMethod: ResourceAccessResult["obtainMethod"] =
    skill === "farming"  ? "harvested" :
    skill === "forestry" ? "chopped"   :
    skill === "mining"   ? "mined"     : "unknown";

  return assembleResult(obtainMethod, skill, sourceTier, levelRequired, skills, inventory, allItems, allAchievements, nameMap);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
