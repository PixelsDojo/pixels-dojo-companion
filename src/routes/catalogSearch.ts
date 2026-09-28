import { Router } from "express";
import { fetchItems, fetchAchievements } from "../services/gameLibrary";
import { collectObtainMethodPaths } from "../services/itemLookup";

const router = Router();

// ---------------------------------------------------------------------------
// GET /api/catalog/search?q=<term>
//
// Case-insensitive substring search across both the items and achievements
// catalogs, matching on ID or display name.
//
// Response: { items: [{id, name}], achievements: [{id, name, hasCraftable}] }
// ---------------------------------------------------------------------------

router.get("/api/catalog/search", async (req, res) => {
  const raw = req.query.q;
  if (typeof raw !== "string" || raw.trim() === "") {
    return res.status(400).json({ error: 'Query parameter "q" is required.' });
  }

  const term = raw.trim().toLowerCase();

  let allItems: Record<string, any>;
  let allAchievements: Record<string, any>;
  try {
    [allItems, allAchievements] = await Promise.all([fetchItems(), fetchAchievements()]);
  } catch (err: any) {
    return res
      .status(err.status ?? 502)
      .json({ error: err.message ?? String(err), body: err.body });
  }

  const items = Object.entries(allItems)
    .filter(([id, item]) => {
      const name: string = item?.name ?? item?.label ?? "";
      return id.toLowerCase().includes(term) || name.toLowerCase().includes(term);
    })
    .map(([id, item]) => ({ id, name: item?.name ?? item?.label ?? id }));

  const achievements = Object.entries(allAchievements)
    .filter(([id, ach]) => {
      const name: string = (ach as any)?.name ?? (ach as any)?.label ?? "";
      return id.toLowerCase().includes(term) || name.toLowerCase().includes(term);
    })
    .map(([id, ach]) => ({
      id,
      name: (ach as any)?.name ?? (ach as any)?.label ?? id,
      hasCraftable: (ach as any)?.craftable != null,
    }));

  return res.json({ items, achievements });
});

// ---------------------------------------------------------------------------
// GET /api/catalog/obtain-methods
//
// Diagnostic endpoint: scans every item's onUse object and returns all unique
// key-paths with hit counts, sorted by frequency.  Run this against the live
// server to discover field names for mining/fishing/animal-care sources before
// extending buildHarvestMap in itemLookup.ts.
//
// Example response:
//   { totalItems: 642, paths: [
//     { path: "onUse.plant.fruit", count: 87 },
//     { path: "onUse.placeEntity.entity", count: 87 },
//     ...
//   ]}
// ---------------------------------------------------------------------------

router.get("/api/catalog/obtain-methods", async (req, res) => {
  let allItems: Record<string, any>;
  try {
    allItems = await fetchItems();
  } catch (err: any) {
    return res.status(502).json({ error: err.message ?? String(err) });
  }

  const rawCounts = collectObtainMethodPaths(allItems);
  const paths = Object.entries(rawCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([path, count]) => ({ path, count }));

  return res.json({ totalItems: Object.keys(allItems).length, paths });
});

export default router;
