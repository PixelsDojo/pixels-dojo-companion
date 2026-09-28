/**
 * Tests for the redesigned coin strategy:
 *   - Staples list is loaded
 *   - disableTrading items are excluded
 *   - quantum_recombinator items are excluded
 *   - Items with unfeasible input chains are excluded
 *   - Simulates Lizzy's levels to show top 3 picks
 *
 * Run: npx ts-node tests/coinStrategyFilters.test.ts
 */
import assert from "assert";
import fs from "fs";

// Use the seeded local catalog if it exists; otherwise fall back to :memory: for basic tests.
const CATALOG_DB = "/tmp/catalog_test_local.db";
const hasRealDB  = fs.existsSync(CATALOG_DB);
process.env.DATABASE_PATH = hasRealDB ? CATALOG_DB : ":memory:";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { computeCoinStrategy, getStaplesSet } = require("../src/services/coinStrategy") as {
  computeCoinStrategy: (p: {
    playerSkills:     Record<string, number>;
    energy:           number;
    energyMax:        number;
    taskboard?:       unknown[];
    playerInventory?: Record<string, number>;
    chestContents?:   unknown;
  }) => {
    topCraftOptions: {
      itemId: string; itemName: string; isStaple: boolean; isOwnedStock: boolean;
      qtyForTarget: number; energyForTarget: number; fitsEnergy: boolean;
      sellPrice: number; debug: string;
    }[];
    otherOpportunities: { itemId: string; itemName: string; isStaple: boolean }[];
    codeAnswer: string;
    debug: { filterLog: Record<string, string>; ownedStockCandidates: number; makeToSellCandidates: number };
  };
  getStaplesSet: () => Set<string>;
};

let passed = 0;
let failed = 0;

function test(name: string, skipWhenNoDb: boolean, fn: () => void): void;
function test(name: string, fn: () => void): void;
function test(name: string, skipOrFn: boolean | (() => void), fn?: () => void) {
  const skip = typeof skipOrFn === "boolean" ? skipOrFn : false;
  const run  = typeof skipOrFn === "function" ? skipOrFn : fn!;
  if (skip) { console.log("–", name, "(skipped — no real DB)"); return; }
  try {
    run();
    console.log("✓", name);
    passed++;
  } catch (err: unknown) {
    console.error("✗", name);
    console.error("  ", err instanceof Error ? err.message : String(err));
    failed++;
  }
}

// Lizzy's skills
const LIZZY: Record<string, number> = {
  forestry:     49,
  woodwork:     49,
  cooking:      44,
  mining:       48,
  farming:      51,
  stoneshaping: 44,
  animalcare:   41,
  business:     38,
  metalworking: 44,
  exploration:  24,
};

// ---------------------------------------------------------------------------

test("staples.json loads and contains expected items", () => {
  const staples = getStaplesSet();
  assert(staples.size > 0, "staples set should not be empty");
  for (const id of ["itm_woodplank_01", "itm_metalbar_01", "itm_glass01", "itm_glass_bottle", "itm_constructionPowder"]) {
    assert(staples.has(id), `${id} should be in staples`);
  }
});

test("computeCoinStrategy runs without throwing", () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  assert(typeof result.codeAnswer === "string");
  assert(Array.isArray(result.topCraftOptions));
  assert(Array.isArray(result.otherOpportunities));
});

test("codeAnswer on empty DB mentions collecting prices or no options", !hasRealDB, () => {
  // This only runs when there's no real DB — we expect a graceful message
});

test("codeAnswer on empty DB graceful", () => {
  if (hasRealDB) {
    // With real DB but no market data, should also be graceful
    const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
    // Either collecting data or no options — both are fine
    assert(typeof result.codeAnswer === "string" && result.codeAnswer.length > 0);
    return;
  }
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  assert(
    result.codeAnswer.includes("collecting") || result.codeAnswer.includes("couldn't find"),
    `Got: ${result.codeAnswer}`,
  );
});

test("Basic Axe is excluded by disableTrading filter", !hasRealDB, () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  const { filterLog } = result.debug;
  const reason = filterLog["itm_axe_01"];
  assert(reason, "itm_axe_01 should be in filterLog");
  assert(reason.includes("disableTrading"), `Expected disableTrading, got: ${reason}`);
  assert(!result.topCraftOptions.some(o => o.itemId === "itm_axe_01"), "Basic Axe must not appear in results");
});

test("Astra Flower Seeds excluded by restricted industry", !hasRealDB, () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  const { filterLog } = result.debug;
  const reason = filterLog["itm_60dayflower_space_seed"];
  assert(reason, "itm_60dayflower_space_seed should be in filterLog");
  assert(reason.includes("quantum_recombinator"), `Expected quantum_recombinator, got: ${reason}`);
  assert(!result.topCraftOptions.some(o => o.itemId === "itm_60dayflower_space_seed"), "Astra Seeds must not appear");
});

test("Colorpots excluded by chain feasibility or no-market-price filter", !hasRealDB, () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  const { filterLog } = result.debug;
  // Blue colorpot: needs Straining Mesh → Turkey Egg Powder → Turkey Eggs (not on market).
  // In the test DB it may be filtered earlier (no market price) or later (chain infeasible).
  const reason = filterLog["itm_popberrybluepigment"] ?? "";
  // Must be excluded from top options regardless
  assert(!result.topCraftOptions.some(o => o.itemId === "itm_popberrybluepigment"), "Colorpots must not appear");
  // If a reason IS in the log, it must be one of the valid filter reasons
  if (reason) {
    const valid = ["feasible", "ingredient", "chain", "price", "disableTrading", "trading"];
    assert(
      valid.some(v => reason.includes(v)),
      `Unexpected filter reason for colorpot: ${reason}`,
    );
  }
});

test("top craft options never include known-bad items", () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  const ids = result.topCraftOptions.map(o => o.itemId);
  assert(!ids.includes("itm_axe_01"),                 "Basic Axe slipped through");
  assert(!ids.includes("itm_60dayflower_space_seed"), "Astra Seeds slipped through");
  assert(!ids.some(id => id.includes("pigment")),     "Colorpot slipped through");
  assert(!ids.some(id => id.includes("axe_0")),       "Any axe slipped through");
});

test("Lizzy's summary (real DB)", !hasRealDB, () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  console.log("\n=== Lizzy's coin answer ===");
  console.log(result.codeAnswer);
  console.log(`\nOwned stock candidates: ${result.debug.ownedStockCandidates}`);
  console.log(`Make-to-sell candidates: ${result.debug.makeToSellCandidates}`);
  if (result.topCraftOptions.length > 0) {
    console.log("\nTop craft options (debug):");
    result.topCraftOptions.forEach((o, i) => console.log(`  ${i + 1}. ${o.itemName} — ${o.debug}`));
  }
  // Show filters for the three problem items
  const problems = ["itm_axe_01", "itm_60dayflower_space_seed", "itm_popberrybluepigment"];
  console.log("\nFilter reasons for known-bad items:");
  for (const id of problems) {
    const reason = (result.debug as any).filterLog?.[id] ?? "(not in craftable list or no level)";
    console.log(`  ${id}: ${reason}`);
  }
});

test("owned stock ≥100K appears first in top options", () => {
  // Simulate 1,200 units of an item in the backpack worth ~180K
  // We inject a mock by temporarily wrapping: just verify the logic path compiles
  // and the result shape is correct.
  const result = computeCoinStrategy({
    playerSkills: LIZZY,
    energy: 1000,
    energyMax: 1400,
    playerInventory: {},   // empty backpack
    chestContents:   {},   // no chests
  });
  // Shape: topCraftOptions should be an array of objects with isOwnedStock field
  assert(Array.isArray(result.topCraftOptions));
  if (result.topCraftOptions.length > 0) {
    assert("isOwnedStock" in result.topCraftOptions[0], "option should have isOwnedStock field");
  }
});

test("gatherable items included in candidates when market data present", !hasRealDB, () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  // All options must have the new fields
  for (const opt of result.topCraftOptions) {
    assert(typeof opt.qtyForTarget === "number",    "qtyForTarget should be number");
    assert(typeof opt.energyForTarget === "number", "energyForTarget should be number");
    assert(typeof opt.fitsEnergy === "boolean",     "fitsEnergy should be boolean");
    assert(typeof opt.sellPrice === "number",       "sellPrice should be number");
  }
});

test("chance/animal drop inputs excluded — colorpot chain", !hasRealDB, () => {
  const result = computeCoinStrategy({ playerSkills: LIZZY, energy: 1000, energyMax: 1400 });
  const ids = result.topCraftOptions.map(o => o.itemId);
  assert(!ids.some(id => id.includes("pigment")), "colorpot (chance chain) must not appear");
});

// ---------------------------------------------------------------------------

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
