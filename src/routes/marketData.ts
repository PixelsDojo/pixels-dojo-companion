import { Router, Request, Response } from "express";
import {
  upsertMarketPrice, insertMarketSale, listCatalogRows, getMarketPrice,
  getListingLastPq, upsertListingPurchase, upsertPriceHistory,
} from "../db/database";
import { invalidateIngredientCache, computeIngredientUsage, getStaplesSet } from "../services/coinStrategy";

const router = Router();

interface IncomingListing {
  id:           string;   // _id from API
  price:        number;
  qty:          number;   // total quantity listed
  purchasedQty: number;   // units sold from this listing so far
  createdAt:    number;   // unix ms; may arrive as seconds if < 1e10
}

interface IncomingPriceItem {
  itemId:    string;
  minPrice:  number;
  avgPrice?: number;
  volume?:   number;
  listings?: IncomingListing[];
}

// Compute demand metrics from per-listing purchasedQty + createdAt.
// Returns sold_24h_est (units sold from listings created <24 h ago),
// sold_7d_est (per-day rate from listings created <7 d ago), and
// avg_sale_price (qty-weighted over all sold units in the 7-day window).
export function computeDemandFromListings(
  listings: IncomingListing[],
  fetchedAt: number,
): { sold24hEst: number; sold7dEst: number; avgSalePrice: number } {
  const DAY = 86_400_000;
  let sold24h   = 0;
  let sold7d    = 0;
  let soldValue = 0;
  let soldUnits = 0;
  let oldestInWindow = fetchedAt;

  for (const l of listings) {
    const pq = l.purchasedQty ?? 0;
    if (pq <= 0) continue;
    // Guard: if createdAt looks like unix seconds (<year 2001 in ms), convert.
    const createdAtMs = (l.createdAt ?? 0) < 1e10 ? (l.createdAt ?? 0) * 1000 : (l.createdAt ?? 0);
    const age = fetchedAt - createdAtMs;
    if (age < 0) continue; // clock skew — skip
    if (age <= DAY)     sold24h += pq;
    if (age <= 7 * DAY) {
      sold7d     += pq;
      soldValue  += pq * l.price;
      soldUnits  += pq;
      if (createdAtMs > 0 && createdAtMs < oldestInWindow) oldestInWindow = createdAtMs;
    }
  }

  // Per-day rate: divide by the time actually spanned by these listings.
  // Cap at 1 hour minimum to avoid division-by-zero on brand-new listings.
  const daysSpanned = Math.max(1 / 24, (fetchedAt - oldestInWindow) / DAY);
  const sold7dEst   = daysSpanned > 0 ? sold7d / daysSpanned : 0;
  const avgSalePrice = soldUnits > 0 ? soldValue / soldUnits : 0;

  return { sold24hEst: sold24h, sold7dEst, avgSalePrice };
}

// POST /api/market/prices
// Body: { items: IncomingPriceItem[] }
// Called by the browser extension after fetching marketplace data.
// Throttle / dedup enforced client-side; backend accepts and upserts.
router.post("/api/market/prices", (req: Request, res: Response) => {
  const items = req.body?.items;
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "items array required" });
    return;
  }

  let accepted = 0;
  let skipped  = 0;
  const fetchedAt = Date.now();

  for (const item of items as IncomingPriceItem[]) {
    if (
      typeof item.itemId !== "string" ||
      typeof item.minPrice !== "number" ||
      !Number.isFinite(item.minPrice)
    ) {
      skipped++;
      continue;
    }

    const avgPrice = typeof item.avgPrice === "number" && Number.isFinite(item.avgPrice)
      ? item.avgPrice
      : item.minPrice;
    const volume = typeof item.volume === "number" ? item.volume : 0;

    let sold24hEst   = 0;
    let sold7dEst    = 0;
    let avgSalePrice = 0;

    if (Array.isArray(item.listings) && item.listings.length > 0) {
      // Filter + normalise listing shape (privacy: no ownerId stored or used)
      const validListings: IncomingListing[] = item.listings.filter(
        l => typeof l.id === "string" && typeof l.price === "number" && l.price > 0,
      );

      if (validListings.length > 0) {
        // Instant demand from purchasedQty × listing age
        ({ sold24hEst, sold7dEst, avgSalePrice } = computeDemandFromListings(validListings, fetchedAt));

        // Delta tracking: purchasedQty increases across fetches = exact sales
        for (const l of validListings) {
          const prevPq = getListingLastPq(l.id);
          if (prevPq >= 0 && l.purchasedQty > prevPq) {
            const delta = l.purchasedQty - prevPq;
            insertMarketSale(item.itemId, fetchedAt, l.price, delta);
          }
          upsertListingPurchase(l.id, item.itemId, l.purchasedQty ?? 0, l.price);
        }
      }
    }

    upsertMarketPrice(item.itemId, item.minPrice, avgPrice, volume, sold24hEst, sold7dEst, avgSalePrice);
    // Daily price snapshot for trend detection
    upsertPriceHistory(item.itemId, avgSalePrice > 0 ? avgSalePrice : avgPrice, item.minPrice);
    accepted++;
  }

  // Bust the ingredient usage cache so next coin strategy call re-reads
  invalidateIngredientCache();

  res.json({ accepted, skipped });
});

// GET /api/market/priority-items
// Returns all catalog items sorted by recipe-usage count (desc), with staleness flag.
// Staples use a 2 h stale threshold; all other items use 6 h.
// The browser extension calls this once at startup to build its background collector queue.
router.get("/api/market/priority-items", (_req: Request, res: Response) => {
  const ingUsage        = computeIngredientUsage();
  const staples         = getStaplesSet();
  const now             = Date.now();
  const staleMs         = 6 * 3600 * 1000;
  const stapleStaleMs   = 2 * 3600 * 1000;
  const staleThreshold  = now - staleMs;
  const stapleThreshold = now - stapleStaleMs;

  const items = listCatalogRows()
    .filter(r => r.item_id && r.category !== null)   // skip unclassified — not tradeable
    .map(r => {
      const id        = r.item_id!;
      const isStaple  = staples.has(id);
      const price     = getMarketPrice(id);
      const updatedAt = price?.updated_at ?? 0;
      const threshold = isStaple ? stapleThreshold : staleThreshold;
      return {
        itemId:      id,
        displayName: r.display_name ?? id,
        usageCount:  ingUsage.get(id) ?? 0,
        isCrafted:   r.category === "crafted",
        isStaple,
        updatedAt,
        isStale:     updatedAt < threshold,
      };
    })
    .sort((a, b) => {
      // Staples first, then by ingredient usage count
      if (a.isStaple !== b.isStaple)     return a.isStaple ? -1 : 1;
      if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
      if (a.isCrafted !== b.isCrafted)   return a.isCrafted ? -1 : 1;
      return a.itemId.localeCompare(b.itemId);
    });

  res.json({ items, total: items.length, staleCount: items.filter(i => i.isStale).length });
});

// GET /debug/market-status?key=<DEBUG_KEY>
// Returns counts of priced items and the 10 most recently updated. Disabled if DEBUG_KEY unset.
router.get("/debug/market-status", (req: Request, res: Response) => {
  const debugKey = process.env.DEBUG_KEY ?? "";
  if (!debugKey || req.query.key !== debugKey) {
    res.status(403).json({ error: "forbidden" });
    return;
  }

  const now  = Date.now();
  const h6   = now - 6  * 3600 * 1000;
  const h24  = now - 24 * 3600 * 1000;

  let totalWithPrices = 0;
  let updatedLast6h   = 0;
  let updatedLast24h  = 0;
  const recent: { itemId: string; displayName: string; updatedAt: number; minPrice: number }[] = [];

  for (const row of listCatalogRows()) {
    if (!row.item_id) continue;
    const price = getMarketPrice(row.item_id);
    if (!price) continue;
    totalWithPrices++;
    if (price.updated_at >= h6)  updatedLast6h++;
    if (price.updated_at >= h24) updatedLast24h++;
    recent.push({
      itemId:      row.item_id,
      displayName: row.display_name ?? row.item_id,
      updatedAt:   price.updated_at,
      minPrice:    price.min_price,
    });
  }

  recent.sort((a, b) => b.updatedAt - a.updatedAt);

  res.json({ totalWithPrices, updatedLast6h, updatedLast24h, mostRecent: recent.slice(0, 10) });
});

export default router;
