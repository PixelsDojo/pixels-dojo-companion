/**
 * Tests for computeDemandFromListings (purchasedQty-based demand estimation).
 *
 * Run: npx ts-node tests/marketDemand.test.ts
 *
 * Uses only Node built-ins + ts-node (no extra test framework).
 */
import assert from "assert";

process.env.DATABASE_PATH = ":memory:";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeDemandFromListings } = require("../src/routes/marketData") as {
  computeDemandFromListings: (
    listings: { id: string; price: number; qty: number; purchasedQty: number; createdAt: number }[],
    fetchedAt: number
  ) => { sold24hEst: number; sold7dEst: number; avgSalePrice: number };
};

const HOUR = 3_600_000;
const DAY  = 86_400_000;
const fetchedAt = 1_700_000_000_000; // fixed reference point

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log("✓", name);
    passed++;
  } catch (err: unknown) {
    console.error("✗", name);
    console.error("  ", err instanceof Error ? err.message : String(err));
    failed++;
  }
}

function approxEqual(a: number, b: number, tolerance: number, msg: string) {
  assert(Math.abs(a - b) <= tolerance, `${msg}: expected ~${b}, got ${a}`);
}

// ---------------------------------------------------------------------------

test("itm_petfood: single listing 8h old, purchasedQty=183", () => {
  const listings = [
    { id: "listing_abc123", price: 1970, qty: 200, purchasedQty: 183, createdAt: fetchedAt - 8 * HOUR },
  ];
  const { sold24hEst, sold7dEst, avgSalePrice } = computeDemandFromListings(listings, fetchedAt);

  // All 183 units within 24h window
  assert.strictEqual(sold24hEst, 183);

  // daysSpanned = 8h = 8/24 days → sold7dEst = 183 / (8/24) ≈ 549
  approxEqual(sold7dEst, 549, 5, "sold7dEst");

  assert.strictEqual(avgSalePrice, 1970);
});

test("listing older than 24h excluded from sold_24h_est but included in sold_7d_est", () => {
  const listings = [
    { id: "listing_old", price: 500, qty: 50, purchasedQty: 30, createdAt: fetchedAt - 2 * DAY },
  ];
  const { sold24hEst, sold7dEst, avgSalePrice } = computeDemandFromListings(listings, fetchedAt);

  assert.strictEqual(sold24hEst, 0);
  // daysSpanned = 2 → sold7dEst = 30/2 = 15
  approxEqual(sold7dEst, 15, 1, "sold7dEst");
  assert.strictEqual(avgSalePrice, 500);
});

test("listing older than 7 days is excluded entirely", () => {
  const listings = [
    { id: "listing_ancient", price: 999, qty: 100, purchasedQty: 80, createdAt: fetchedAt - 10 * DAY },
  ];
  const { sold24hEst, sold7dEst, avgSalePrice } = computeDemandFromListings(listings, fetchedAt);

  assert.strictEqual(sold24hEst, 0);
  assert.strictEqual(sold7dEst, 0);
  assert.strictEqual(avgSalePrice, 0);
});

test("listing with purchasedQty=0 contributes nothing", () => {
  const listings = [
    { id: "listing_unsold", price: 750, qty: 20, purchasedQty: 0, createdAt: fetchedAt - HOUR },
  ];
  const { sold24hEst, sold7dEst, avgSalePrice } = computeDemandFromListings(listings, fetchedAt);

  assert.strictEqual(sold24hEst, 0);
  assert.strictEqual(sold7dEst, 0);
  assert.strictEqual(avgSalePrice, 0);
});

test("unix-seconds createdAt is auto-converted", () => {
  const createdAtSeconds = Math.floor((fetchedAt - 4 * HOUR) / 1000); // < 1e10
  const listings = [
    { id: "listing_seconds", price: 300, qty: 10, purchasedQty: 7, createdAt: createdAtSeconds },
  ];
  const { sold24hEst, sold7dEst } = computeDemandFromListings(listings, fetchedAt);

  assert.strictEqual(sold24hEst, 7);
  assert(sold7dEst > 0, "sold7dEst should be > 0");
});

test("multiple listings across different ages", () => {
  const listings = [
    { id: "l1", price: 1000, qty: 50, purchasedQty: 20, createdAt: fetchedAt - 12 * HOUR },
    { id: "l2", price: 1200, qty: 30, purchasedQty: 10, createdAt: fetchedAt - 3 * DAY },
    { id: "l3", price:  800, qty: 10, purchasedQty:  5, createdAt: fetchedAt - 8 * DAY }, // outside 7d window
  ];
  const { sold24hEst, sold7dEst, avgSalePrice } = computeDemandFromListings(listings, fetchedAt);

  // Only l1 within 24h
  assert.strictEqual(sold24hEst, 20);

  // l1 + l2 within 7d; daysSpanned from oldest-in-window = 3 days → sold7dEst = 30/3 = 10
  approxEqual(sold7dEst, 10, 1, "sold7dEst");

  // avgSalePrice = (20*1000 + 10*1200) / 30 ≈ 1066.67
  approxEqual(avgSalePrice, 1066.67, 1, "avgSalePrice");
});

test("empty listings array returns zeros", () => {
  const { sold24hEst, sold7dEst, avgSalePrice } = computeDemandFromListings([], fetchedAt);

  assert.strictEqual(sold24hEst, 0);
  assert.strictEqual(sold7dEst, 0);
  assert.strictEqual(avgSalePrice, 0);
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
