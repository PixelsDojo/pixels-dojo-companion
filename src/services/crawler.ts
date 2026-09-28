import { upsertLandPlacement } from "../db/database";

// Base URL of the Pixels production server.
// Set PIXELS_SERVER_URL in Railway env vars if the default changes.
const PIXELS_SERVER =
  process.env.PIXELS_SERVER_URL?.replace(/\/$/, "") ??
  "https://pixels-server.pixels.xyz";

const FARM_ID_MIN = 1;
const FARM_ID_MAX = 5000;
const REQUEST_DELAY_MS = 1050; // ~1 req/s per land (both sub-requests fire before the sleep)
const LOG_INTERVAL = 100;
const CRAWL_REPEAT_MS = 4 * 60 * 60 * 1000; // re-crawl every 4 hours

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

// Confirmed shape from DevTools against live lands (e.g. pixelsNFTFarm-486,
// pixelsNFTFarm-3339). tenants is always empty; labels carries type + tier info.
interface MapResponse {
  id:           string;
  name:         string;
  type:         string;
  tenants:      string[];
  labels:       string[];
  ownerAddress: string;
  tenantKey?:   string;
}

// Confirmed shape from browser verification of /v1/infiniportal/farm_details/{id}.
// Returns entity placements, soil/tree counts, and access permissions for any land.
interface FarmDetailsResponse {
  entities:     { id: string; world: number; entity: string }[];
  soilCount:    number;
  treeCount:    number;
  player?:      { _id: string; username: string; cryptoWallets: unknown[] };
  permissions?: { use?: string[] };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

// Parse the land environment type from the labels array.
// Known values: "space", "land", "water".
function parseLandType(labels: string[]): string | null {
  return labels.find((l) => ["space", "land", "water"].includes(l)) ?? null;
}

// Extract tier labels from the labels array (e.g. "tier2", "tier3", "tier5").
function parseTiers(labels: string[]): string[] {
  return labels.filter((l) => /^tier\d+$/.test(l));
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

const BROWSER_HEADERS = {
  Origin:  "https://play.pixels.xyz",
  Referer: "https://play.pixels.xyz/",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
};

async function fetchMap(farmId: number): Promise<MapResponse | null> {
  const id = `pixelsNFTFarm-${farmId}`;
  const url = `${PIXELS_SERVER}/v1/map/${id}`;
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(12_000),
  });

  if (res.status === 404) return null; // farmId not in use — expected, skip silently

  if (res.status === 403) {
    const body = await res.text().catch(() => "(could not read body)");
    throw new Error(`/v1/map HTTP 403 — body: ${body}`);
  }

  if (!res.ok) throw new Error(`/v1/map HTTP ${res.status}`);

  return res.json() as Promise<MapResponse>;
}

async function fetchFarmDetails(farmId: number): Promise<FarmDetailsResponse | null> {
  const id = `pixelsNFTFarm-${farmId}`;
  const url = `${PIXELS_SERVER}/v1/infiniportal/farm_details/${id}`;
  const res = await fetch(url, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(12_000),
  });

  if (res.status === 404) return null;

  if (res.status === 403) {
    const body = await res.text().catch(() => "(could not read body)");
    throw new Error(`/v1/infiniportal HTTP 403 — body: ${body}`);
  }

  if (!res.ok) throw new Error(`/v1/infiniportal HTTP ${res.status}`);

  return res.json() as Promise<FarmDetailsResponse>;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Crawl loop
// ---------------------------------------------------------------------------

async function runCrawl(): Promise<void> {
  console.log(
    `[crawler] starting crawl pixelsNFTFarm-${FARM_ID_MIN}..${FARM_ID_MAX} — ` +
    `both /v1/map + /v1/infiniportal/farm_details per land, ~1 req/s`
  );
  const startMs = Date.now();
  let found = 0;
  let skipped = 0;  // 404 on map endpoint
  let errors = 0;

  for (let farmId = FARM_ID_MIN; farmId <= FARM_ID_MAX; farmId++) {
    try {
      // Fetch map metadata first; 404 here means the farm ID is unoccupied — skip both.
      const mapData = await fetchMap(farmId);

      if (mapData === null) {
        skipped++;
      } else {
        // Map exists — fetch entity/permission details from the second endpoint.
        // Failures here are logged but don't prevent saving the map metadata.
        let details: FarmDetailsResponse | null = null;
        try {
          details = await fetchFarmDetails(farmId);
        } catch (detailErr) {
          console.warn(
            `[crawler] pixelsNFTFarm-${farmId} farm_details failed:`,
            detailErr instanceof Error ? detailErr.message : detailErr
          );
        }

        const labels = mapData.labels ?? [];
        const entities = details?.entities ?? [];

        upsertLandPlacement({
          landId:         `pixelsNFTFarm-${farmId}`,
          name:           mapData.name ?? null,
          ownerAddress:   mapData.ownerAddress ?? null,
          ownerUsername:  details?.player?.username ?? null,
          landType:       parseLandType(labels),
          tiersAvailable: parseTiers(labels),
          entities:       entities.map((e) => e.entity).filter(Boolean),
          soilCount:      details?.soilCount ?? null,
          treeCount:      details?.treeCount ?? null,
          permissionsUse: details?.permissions?.use ?? [],
          lastCrawled:    Date.now(),
        });
        found++;
      }
    } catch (err) {
      errors++;
      console.warn(
        `[crawler] pixelsNFTFarm-${farmId} failed:`,
        err instanceof Error ? err.message : err
      );
    }

    if (farmId % LOG_INTERVAL === 0) {
      const elapsed = Math.round((Date.now() - startMs) / 1000);
      console.log(
        `[crawler] progress ${farmId}/${FARM_ID_MAX} — ` +
          `found=${found} skipped=${skipped} errors=${errors} elapsed=${elapsed}s`
      );
    }

    await sleep(REQUEST_DELAY_MS);
  }

  const totalSec = Math.round((Date.now() - startMs) / 1000);
  console.log(
    `[crawler] complete — found=${found} skipped=${skipped} errors=${errors} total=${totalSec}s`
  );
}

let crawlRunning = false;

async function safeCrawl(): Promise<void> {
  if (crawlRunning) {
    console.log("[crawler] previous crawl still running — skipping this cycle");
    return;
  }
  crawlRunning = true;
  try {
    await runCrawl();
  } catch (err) {
    console.error("[crawler] unexpected error:", err);
  } finally {
    crawlRunning = false;
  }
}

export function startCrawler(): void {
  console.log(
    `[crawler] scheduled — first run in 10 s, then every ${CRAWL_REPEAT_MS / 3_600_000} h`
  );
  // Small delay so Railway's health check passes before we start making requests.
  setTimeout(() => {
    safeCrawl();
    setInterval(safeCrawl, CRAWL_REPEAT_MS);
  }, 10_000);
}
