/**
 * Marketplace price lookup — returns the lowest current per-unit listing price
 * for an item, with a 10-minute server-side cache per item ID.
 *
 * Endpoint: GET /v1/marketplace/item/{itemId}?pid={playerId}
 * Auth: game session token forwarded from the extension (Authorization header).
 *       If unavailable the call is attempted without auth — may still work for
 *       server-side requests where CORS/session enforcement doesn't apply.
 *
 * Response shapes handled:
 *   A) Aggregated stats: { minPrice, avgPrice, maxPrice, volume, currency }
 *   B) Listings array:   { listings: [{price, quantity, ...}] }
 *      (also tried under .data / .items if .listings is absent)
 *
 * Run window.testMarketplaceFetch('itm_plaster', playerId) in the game's
 * DevTools console to confirm the live response shape.
 */

const PIXELS_SERVER =
  process.env.PIXELS_SERVER ?? "https://pixels-server.pixels.xyz";

const BASE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://pixels.xyz",
  Referer: "https://pixels.xyz/",
};

const CACHE_TTL_MS = 10 * 60_000; // 10 minutes

export interface MarketListing {
  lowestPrice: number;  // lowest per-unit price in Coins
  quantity: number;     // total units available across all visible listings
}

const _cache = new Map<string, { data: MarketListing; expiresAt: number }>();

/**
 * Returns the lowest listing price per unit for `itemId`, or null when the
 * item has no listings or the endpoint is unreachable.
 */
export async function fetchMarketPrice(
  itemId: string,
  opts: { pid: string; authToken?: string | null },
): Promise<MarketListing | null> {
  const now = Date.now();
  const cached = _cache.get(itemId);
  if (cached && cached.expiresAt > now) return cached.data;

  const url = `${PIXELS_SERVER}/v1/marketplace/item/${encodeURIComponent(itemId)}?pid=${encodeURIComponent(opts.pid)}`;
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (opts.authToken) headers.Authorization = opts.authToken;

  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    const result = _parseResponse(body);
    if (result) _cache.set(itemId, { data: result, expiresAt: now + CACHE_TTL_MS });
    return result;
  } catch {
    return null;
  }
}

/**
 * Batch-fetch prices for multiple item IDs concurrently.
 * Returns a map of itemId → MarketListing (only entries that resolved).
 */
export async function fetchMarketPrices(
  itemIds: string[],
  opts: { pid: string; authToken?: string | null },
): Promise<Map<string, MarketListing>> {
  const unique = [...new Set(itemIds)];
  const results = await Promise.all(
    unique.map(async (id) => [id, await fetchMarketPrice(id, opts).catch(() => null)] as const),
  );
  const map = new Map<string, MarketListing>();
  for (const [id, listing] of results) {
    if (listing) map.set(id, listing);
  }
  return map;
}

function _parseResponse(body: unknown): MarketListing | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // Shape A — aggregated stats
  if (typeof b.minPrice === "number" && b.minPrice > 0) {
    const vol =
      typeof b.totalVolume === "number" ? b.totalVolume
      : typeof b.volume === "number"    ? b.volume
      : 0;
    return { lowestPrice: b.minPrice, quantity: vol };
  }

  // Shape B — listings array (try common key names)
  const raw =
    Array.isArray(b.listings) ? b.listings
    : Array.isArray(b.data)   ? b.data
    : Array.isArray(b.items)  ? b.items
    : null;
  if (raw && raw.length > 0) {
    const valid = (raw as Record<string, unknown>[])
      .filter((l) => typeof l.price === "number" && (l.price as number) > 0)
      .sort((a, b) => (a.price as number) - (b.price as number));
    if (valid.length > 0) {
      const totalQty = valid.reduce(
        (s, l) => s + (typeof l.quantity === "number" ? (l.quantity as number) : 1),
        0,
      );
      return { lowestPrice: valid[0].price as number, quantity: totalQty };
    }
  }

  return null;
}
