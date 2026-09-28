import { Router } from "express";
import { fetchItems, fetchAchievements } from "../services/gameLibrary";

const router = Router();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CraftEfficiencyResult {
  itemId: string;
  itemName: string;
  xpPerCraft: number;
  xpSkill: string;
  energyCost: number;
  craftTimeMinutes: number;
  ingredients: Array<{ itemId: string; itemName: string; quantity: number; marketPrice: null }>;
  outputQuantity: number;
  requiredSkill: string | null;
  requiredLevel: number;
  requiredTier: number;
  canCraftNow: boolean;
}

// ---------------------------------------------------------------------------
// computeCraftEfficiency
// ---------------------------------------------------------------------------

export async function computeCraftEfficiency(
  itemId: string,
  playerLevel: number,
): Promise<CraftEfficiencyResult | null> {
  const [allItems, allAchievements] = await Promise.all([fetchItems(), fetchAchievements()]);

  // Find the achievement: try direct lookup first, then scan for a craftable
  // whose output includes itemId.
  let achievement: Record<string, any> | null = null;
  let achievementItemName: string | null = null;

  const direct = allAchievements[itemId];
  if (direct?.craftable) {
    achievement = direct;
    achievementItemName = allItems[itemId]?.name ?? allItems[itemId]?.label ?? itemId;
  } else {
    for (const [, ach] of Object.entries(allAchievements)) {
      const a = ach as Record<string, any>;
      const resultItems: any[] = a?.craftable?.result?.items ?? [];
      const match = resultItems.find((ri: any) => ri?.id === itemId);
      if (match) {
        achievement = a;
        achievementItemName = allItems[itemId]?.name ?? allItems[itemId]?.label ?? itemId;
        break;
      }
    }
  }

  if (!achievement) return null;

  const craftable = achievement.craftable as Record<string, any>;

  // XP — sum all exps entries; grab the skill name from the first entry
  const exps: any[] = craftable?.result?.exps ?? [];
  const xpPerCraft = exps.reduce((sum: number, e: any) => {
    return sum + (typeof e?.exp === "number" ? e.exp : 0);
  }, 0);
  const xpSkill: string = exps[0]?.type ?? "";

  // Energy + time
  const energyCost: number = typeof craftable?.energy === "number" ? craftable.energy : 0;
  const craftTimeMinutes: number =
    typeof craftable?.minutesRequired === "number" ? craftable.minutesRequired : 0;

  // Ingredients
  const requiredItems: any[] = craftable?.requiredItems ?? [];
  const ingredients = requiredItems.map((ri: any) => {
    const ingId: string = ri?.id ?? "";
    const ingName: string =
      allItems[ingId]?.name ?? allItems[ingId]?.label ?? ingId;
    const quantity: number = typeof ri?.quantity === "number" ? ri.quantity : 1;
    return { itemId: ingId, itemName: ingName, quantity, marketPrice: null as null };
  });

  // Output quantity — sum of result.items quantities matching our itemId
  const resultItems: any[] = craftable?.result?.items ?? [];
  const outputQuantity: number = resultItems.reduce((sum: number, ri: any) => {
    if (ri?.id === itemId) return sum + (typeof ri?.quantity === "number" ? ri.quantity : 1);
    return sum;
  }, 0) || 1;

  // Skill requirements
  const requiredSkill: string | null =
    typeof craftable?.requiredSkill === "string" ? craftable.requiredSkill : null;
  const requiredLevel: number =
    typeof craftable?.requiredLevel === "number" ? craftable.requiredLevel : 0;
  const requiredTier: number =
    typeof craftable?.requiredTier === "number" ? craftable.requiredTier : 0;

  const canCraftNow = playerLevel >= requiredLevel;

  return {
    itemId,
    itemName: achievementItemName ?? itemId,
    xpPerCraft,
    xpSkill,
    energyCost,
    craftTimeMinutes,
    ingredients,
    outputQuantity,
    requiredSkill,
    requiredLevel,
    requiredTier,
    canCraftNow,
  };
}

// ---------------------------------------------------------------------------
// GET /api/craft-efficiency/:itemId?playerLevel=N
// ---------------------------------------------------------------------------

router.get("/api/craft-efficiency/:itemId", async (req, res) => {
  const { itemId } = req.params;
  const rawLevel = req.query.playerLevel;

  let playerLevel = 0;
  if (rawLevel !== undefined) {
    const parsed = Number(rawLevel);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return res.status(400).json({ error: "playerLevel must be a non-negative integer" });
    }
    playerLevel = parsed;
  }

  let result: CraftEfficiencyResult | null;
  try {
    result = await computeCraftEfficiency(itemId, playerLevel);
  } catch (err: any) {
    return res
      .status(err.status ?? 502)
      .json({ error: err.message ?? String(err), body: err.body });
  }

  if (!result) {
    return res.status(404).json({ error: `No craftable recipe found for '${itemId}'` });
  }

  return res.json(result);
});

export default router;
