import { Router, Request, Response } from "express";
import {
  listNotebookGoals, insertNotebookGoal, updateNotebookGoal, deleteNotebookGoal,
  listShoppingItems, insertShoppingItem, deleteShoppingItem as dbDeleteShoppingItem,
  listTimers, insertTimer, deleteTimer as dbDeleteTimer,
  listDiaryEntries,
} from "../db/database";
import {
  findItemsInQuestion, ItemMatch,
  resolveCraftableRecursive, buildHarvestMap, RecursiveLeaf,
} from "../services/itemLookup";
import { fetchItems, fetchAchievements } from "../services/gameLibrary";

const router = Router();

function validatePlayerId(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

// ---------------------------------------------------------------------------
// GET /api/notebook — goals + shopping items + timers in one call
// ---------------------------------------------------------------------------

router.get("/api/notebook", (req: Request, res: Response) => {
  const playerId = validatePlayerId(req.query.playerId);
  if (!playerId) { res.status(400).json({ error: "playerId required" }); return; }
  res.json({
    goals:         listNotebookGoals(playerId),
    shoppingItems: listShoppingItems(playerId),
    timers:        listTimers(playerId),
  });
});

// ---------------------------------------------------------------------------
// Goals CRUD
// ---------------------------------------------------------------------------

router.post("/api/goals", (req: Request, res: Response) => {
  const { playerId: rawId, text: rawText } = req.body as Record<string, unknown>;
  const playerId = validatePlayerId(rawId);
  const text = typeof rawText === "string" && rawText.trim() ? rawText.trim() : null;
  if (!playerId || !text) { res.status(400).json({ error: "playerId and text required" }); return; }
  res.status(201).json(insertNotebookGoal(playerId, text));
});

router.patch("/api/goals/:id", (req: Request, res: Response) => {
  const { playerId: rawId, completed, text: rawText } = req.body as Record<string, unknown>;
  const playerId = validatePlayerId(rawId);
  const id = parseInt(req.params.id, 10);
  if (!playerId || isNaN(id)) { res.status(400).json({ error: "invalid request" }); return; }
  const goal = updateNotebookGoal(id, playerId, {
    completed: typeof completed === "boolean" ? completed : undefined,
    text: typeof rawText === "string" && rawText.trim() ? rawText.trim() : undefined,
  });
  if (!goal) { res.status(404).json({ error: "goal not found" }); return; }
  res.json(goal);
});

router.delete("/api/goals/:id", (req: Request, res: Response) => {
  const playerId = validatePlayerId(req.query.playerId);
  const id = parseInt(req.params.id, 10);
  if (!playerId || isNaN(id)) { res.status(400).json({ error: "invalid request" }); return; }
  deleteNotebookGoal(id, playerId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Shopping list CRUD
// ---------------------------------------------------------------------------

router.post("/api/shopping-list", (req: Request, res: Response) => {
  const { playerId: rawId, text: rawText, quantity: rawQty } = req.body as Record<string, unknown>;
  const playerId = validatePlayerId(rawId);
  const text = typeof rawText === "string" && rawText.trim() ? rawText.trim() : null;
  const quantity = typeof rawQty === "number" && rawQty >= 1 ? Math.floor(rawQty) : 1;
  if (!playerId || !text) { res.status(400).json({ error: "playerId and text required" }); return; }
  res.status(201).json(insertShoppingItem(playerId, text, quantity));
});

router.delete("/api/shopping-list/:id", (req: Request, res: Response) => {
  const playerId = validatePlayerId(req.query.playerId);
  const id = parseInt(req.params.id, 10);
  if (!playerId || isNaN(id)) { res.status(400).json({ error: "invalid request" }); return; }
  dbDeleteShoppingItem(id, playerId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/shopping-list/craft-totals — aggregate ingredients across the list
// ---------------------------------------------------------------------------

router.get("/api/shopping-list/craft-totals", async (req: Request, res: Response) => {
  const playerId = validatePlayerId(req.query.playerId);
  if (!playerId) { res.status(400).json({ error: "playerId required" }); return; }

  const items = listShoppingItems(playerId);
  if (items.length === 0) { res.json({ totals: [], noRecipeItems: [] }); return; }

  // Fetch library once — all per-item calls below hit the 60 s in-process cache.
  let allItems: Record<string, any>;
  let allAchievements: Record<string, any>;
  try {
    [allItems, allAchievements] = await Promise.all([fetchItems(), fetchAchievements()]);
  } catch (err: any) {
    res.status(502).json({ error: err.message ?? String(err) }); return;
  }
  const harvestMap = buildHarvestMap(allItems);

  const aggregated = new Map<string, RecursiveLeaf>();
  const noRecipeItems: string[] = [];

  for (const item of items) {
    // Name matching — still uses findItemsInQuestion (hits cache, no extra HTTP call).
    let matches: ItemMatch[];
    try { matches = await findItemsInQuestion(item.text); } catch { matches = []; }

    const best = matches[0];
    if (!best) {
      noRecipeItems.push(item.quantity > 1 ? `${item.text} ×${item.quantity}` : item.text);
      continue;
    }

    // craftIngredients === null means no craftable recipe exists in the library.
    if (best.craftIngredients === null) {
      const label = item.quantity > 1 ? `${best.itemName} ×${item.quantity}` : best.itemName;
      noRecipeItems.push(label);
      continue;
    }

    // Full recursive resolution — walks every level until raw ingredients.
    const leafMap = resolveCraftableRecursive(
      best.itemId, item.quantity, allItems, allAchievements, harvestMap,
    );

    for (const [id, leaf] of leafMap) {
      const ex = aggregated.get(id);
      if (ex) { ex.totalQuantity += leaf.totalQuantity; }
      else { aggregated.set(id, { ...leaf }); }
    }
  }

  const totals = [...aggregated.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((leaf) => ({
      id:            leaf.id,
      name:          leaf.name,
      quantity:      leaf.totalQuantity,
      obtainMethod:  leaf.obtainMethod,
      harvestSources: leaf.harvestSources.length > 0 ? leaf.harvestSources : undefined,
    }));

  res.json({ totals, noRecipeItems });
});

// ---------------------------------------------------------------------------
// Timers CRUD
// ---------------------------------------------------------------------------

router.post("/api/timers", (req: Request, res: Response) => {
  const { playerId: rawId, label: rawLabel, fireAt: rawFireAt } = req.body as Record<string, unknown>;
  const playerId = validatePlayerId(rawId);
  const label  = typeof rawLabel  === "string"  && rawLabel.trim() ? rawLabel.trim() : null;
  const fireAt = typeof rawFireAt === "number"  && rawFireAt > 0 ? Math.floor(rawFireAt) : null;
  if (!playerId || !label || !fireAt) { res.status(400).json({ error: "playerId, label and fireAt required" }); return; }
  res.status(201).json(insertTimer(playerId, label, fireAt));
});

router.delete("/api/timers/:id", (req: Request, res: Response) => {
  const playerId = validatePlayerId(req.query.playerId);
  const id = parseInt(req.params.id, 10);
  if (!playerId || isNaN(id)) { res.status(400).json({ error: "invalid request" }); return; }
  dbDeleteTimer(id, playerId);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// GET /api/diary — paginated diary entries, newest first
// ---------------------------------------------------------------------------

router.get("/api/diary", (req: Request, res: Response) => {
  const playerId = validatePlayerId(req.query.playerId);
  if (!playerId) { res.status(400).json({ error: "playerId required" }); return; }
  const page    = Math.max(1, parseInt(String(req.query.page ?? "1"), 10) || 1);
  const perPage = 10;
  const { entries, total } = listDiaryEntries(playerId, page, perPage);
  res.json({ entries, total, page, pages: Math.ceil(total / perPage) || 0 });
});

export default router;
