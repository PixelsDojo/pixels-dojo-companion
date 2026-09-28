import { Router } from "express";
import { listSkillThresholds, upsertSkillThreshold } from "../db/database";
import { fetchItems } from "../services/gameLibrary";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/skill-thresholds/:skill
//
// Fetches the live game library, returns every item that lists the given skill
// under requirements.levels, sorted ascending by required level.
//
// Response: Array<{ itemId: string; itemName: string; level: number }>
// ---------------------------------------------------------------------------
router.get("/api/skill-thresholds/:skill", async (req, res) => {
  const { skill } = req.params;

  let items: Record<string, any>;
  try {
    items = await fetchItems();
  } catch (err: any) {
    return res
      .status(err.status ?? 502)
      .json({ error: err.message ?? String(err), body: err.body });
  }

  const results: Array<{ itemId: string; itemName: string; level: number }> = [];

  for (const [itemId, item] of Object.entries(items)) {
    const levels = item?.requirements?.levels;
    if (!levels || typeof levels !== "object") continue;
    const level = levels[skill];
    if (typeof level !== "number") continue;
    results.push({
      itemId,
      itemName: item.name ?? item.label ?? itemId,
      level,
    });
  }

  results.sort((a, b) => a.level - b.level);
  return res.json(results);
});

// ---------------------------------------------------------------------------
// GET /api/skill-thresholds/:skill/advice
//
// Returns manually-curated prep-advice rows for the given skill from the DB.
// ---------------------------------------------------------------------------
router.get("/api/skill-thresholds/:skill/advice", (req, res) => {
  const { skill } = req.params;
  return res.json(listSkillThresholds(skill));
});

// ---------------------------------------------------------------------------
// PUT /api/skill-thresholds/:skill/advice/:id
//
// Upserts a single prep-advice row. Body: { level, item_id?, prep_advice? }
// ---------------------------------------------------------------------------
router.put("/api/skill-thresholds/:skill/advice/:id", (req, res) => {
  const { skill, id } = req.params;
  const { level, item_id, prep_advice } = req.body ?? {};

  if (typeof level !== "number" || !Number.isInteger(level) || level < 1) {
    return res.status(400).json({ error: "level must be a positive integer" });
  }

  upsertSkillThreshold({
    id,
    skill,
    level,
    item_id: typeof item_id === "string" ? item_id : null,
    prep_advice: typeof prep_advice === "string" ? prep_advice : null,
  });

  return res.json(listSkillThresholds(skill));
});

export default router;
